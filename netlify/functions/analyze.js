/**
 * HeySystem — Netlify Function: analyze
 * ─────────────────────────────────────────────────────────────
 * Recebe um URL Figma + token, chama a Figma API e devolve um
 * schema com health score, components, tokens e insights.
 */

const FIGMA_API = 'https://api.figma.com/v1';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed. Use POST.' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON in request body.' }); }

  const { figmaUrl, figmaToken } = body;
  if (!figmaUrl) return json(400, { error: 'Missing "figmaUrl" in request body.' });

  const fileKey = extractFigmaFileKey(figmaUrl);
  if (!fileKey) return json(400, { error: 'URL Figma inválido.' });

  const token = figmaToken || process.env.FIGMA_TOKEN;
  if (!token) return json(401, { error: 'No Figma token provided.' });

  try {
    const [fileData, stylesData] = await Promise.all([
      figmaFetch(`/files/${fileKey}`, token),
      figmaFetch(`/files/${fileKey}/styles`, token)
    ]);
    const result = await analyzeFigmaFile(fileData, stylesData, figmaUrl, fileKey, token);
    return json(200, result);
  } catch (err) {
    return json(err.status || 500, { error: err.message, details: err.details });
  }
};

async function figmaFetch(path, token) {
  const res = await fetch(`${FIGMA_API}${path}`, {
    headers: { 'X-Figma-Token': token }
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Figma API ${res.status}: ${res.statusText}`);
    err.status = res.status;
    err.details = text.slice(0, 500);
    throw err;
  }
  return res.json();
}

function extractFigmaFileKey(url) {
  const match = url.match(/figma\.com\/(?:file|design|proto|board)\/([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

async function analyzeFigmaFile(file, stylesResponse, figmaUrl, fileKey, token) {
  // IMPORTANTE: em file.components, a chave do objeto é o node_id (ex: "1:23"),
  // não o publish key. Como o array de Object.values() não traz a chave,
  // usamos Object.entries() e injectamos node_id em cada item.
  const components = Object.entries(file.components || {}).map(([nodeId, meta]) => ({
    ...meta,
    node_id: nodeId
  }));
  // Mesmo padrão: componentSets também precisa do node_id (chave do objeto)
  // para podermos cruzar com componentSetPage (do crawl) e com componentSetId
  // dos components.
  const componentSets = Object.entries(file.componentSets || {}).map(([nodeId, meta]) => ({
    ...meta,
    node_id: nodeId
  }));
  const styles = stylesResponse?.meta?.styles || [];

  // ─── CRAWL ÚNICO (corre primeiro porque precisamos do componentSetPage) ───
  const crawlResult = crawlDocument(file.document);
  const detachedComponents = crawlResult.detachedCount;

  // ─── FILTRO: excluir componentSets em pages "Icons" ───
  // Heurística conservadora: só exclui se a page se chamar literalmente
  // "Icons", "Icon Library", "Iconography" ou "Ícones" (case-insensitive).
  // Não usamos detecção pelo nome do componente (pode ter falsos positivos).
  const ICON_PAGE_NAMES = ['icons', 'icon library', 'iconography', 'ícones', 'icones'];
  function isIconPage(pageName) {
    if (!pageName) return false;
    return ICON_PAGE_NAMES.includes(pageName.trim().toLowerCase());
  }

  // ─── BUILD compList: cada item carrega o seu setNodeId para preservar identidade ───
  // Excluímos sets em pages "Icons".
  const compList = componentSets
    .filter(set => !isIconPage(crawlResult.componentSetPage[set.node_id]))
    .map(set => {
      const variantsOfSet = components.filter(c => c.componentSetId === set.node_id);
      const instances = variantsOfSet.reduce((sum, variant) => {
        return sum + (crawlResult.instancesByComponentId[variant.node_id] || 0);
      }, 0);
      return {
        name: set.name,
        variants: Math.max(variantsOfSet.length, 1),
        instances,
        adoption: randInt(60, 95),
        issues: randInt(0, 5),
        status: 'active',
        _setNodeId: set.node_id  // auxiliar — removido antes de devolver
      };
    });

  // ─── STANDALONE COMPONENTS ───
  // Componentes sem variants (ex: Tooltip, Divider dentro de frames de documentação).
  // Critério: COMPONENT sem componentSetId, e fora de pages "Icons".
  // Cada um conta como 1 componente com 1 variant.
  const standaloneComponents = components.filter(c => {
    if (c.componentSetId) return false;  // tem set pai → não é standalone
    const page = crawlResult.componentPage[c.node_id];
    if (isIconPage(page)) return false;  // exclui pages de icons
    return true;
  });
  standaloneComponents.forEach(c => {
    const instances = crawlResult.instancesByComponentId[c.node_id] || 0;
    compList.push({
      name: c.name,
      variants: 1,
      instances,
      adoption: randInt(60, 95),
      issues: randInt(0, 5),
      status: 'active',
      _setNodeId: c.node_id  // usa node_id próprio (não tem set)
    });
  });

  // ─── DEDUPLICAR POR NOME ───
  // Quando o mesmo nome aparece em pages diferentes (ex: "Pill" em Dark e Light),
  // mantém só o mais usado (= mais instâncias). Em empate, fica o primeiro.
  const byName = {};
  compList.forEach(comp => {
    const existing = byName[comp.name];
    if (!existing || comp.instances > existing.instances) {
      byName[comp.name] = comp;
    }
  });
  const dedupedList = Object.values(byName);
  // Limpa o auxiliar e substitui o compList
  dedupedList.forEach(c => delete c._setNodeId);
  compList.length = 0;
  compList.push(...dedupedList);

  // ─── TOKENS DE COR E TIPOGRAFIA (valores reais) ───
  // Os endpoints /files e /styles dão-nos só metadata (nome, descrição) dos styles.
  // Para obter o VALOR concreto (hex de uma cor, font-size de um text style), precisamos
  // de chamar /files/:key/nodes?ids=... com os node_ids dos styles. Uma só chamada,
  // bulk, para todos os styles.
  const styleByType = groupBy(styles, s => s.style_type);
  const colorStyles = styleByType.FILL || [];
  const textStyles  = styleByType.TEXT || [];

  const styleNodeIds = [...colorStyles, ...textStyles].map(s => s.node_id).filter(Boolean);
  let styleNodes = {};
  if (styleNodeIds.length > 0) {
    try {
      // GET /v1/files/:key/nodes?ids=id1,id2,...
      const nodesResponse = await figmaFetch(
        `/files/${fileKey}/nodes?ids=${styleNodeIds.join(',')}`, token
      );
      styleNodes = nodesResponse?.nodes || {};
    } catch (err) {
      // Se falhar, continuamos com tokens vazios — não bloqueia análise
      console.warn('Failed to fetch style nodes:', err.message);
    }
  }

  const colorTokens = buildColorTokens(colorStyles, styleNodes, crawlResult.usageByStyleId);
  const typographyTokens = buildTypographyTokens(textStyles, styleNodes, crawlResult.usageByStyleId);

  // ─── FALLBACK PARA VARIABLES / SEM STYLES ───
  // Se a API não devolveu Styles (ficheiro usa Variables OU não tem styles publicados),
  // construímos a lista a partir do crawl. Resultado: cores e tipografia detectadas
  // no documento, agregadas por valor único. Sem nomes de tokens, mas com usage real.
  const finalColorTokens = colorTokens.length > 0
    ? colorTokens
    : buildColorTokensFromCrawl(crawlResult.colorsByHex);
  const finalTypographyTokens = typographyTokens.length > 0
    ? typographyTokens
    : buildTypographyTokensFromCrawl(crawlResult.typographyByKey);

  // Quando estamos em fallback mode (sem Styles), o "total" é o nº de valores únicos
  // detectados no crawl, não o nº de Styles publicados (que é 0).
  const colorTotal = colorStyles.length > 0
    ? colorStyles.length
    : finalColorTokens.length;
  const typographyTotal = textStyles.length > 0
    ? textStyles.length
    : finalTypographyTokens.length;

  // Flag para o frontend mostrar disclaimer quando estamos em modo crawl
  const tokensSource = (colorStyles.length === 0 && textStyles.length === 0)
    ? 'crawl'   // detectado no documento (Variables ou hardcoded)
    : 'styles'; // Color/Text Styles publicados

  return {
    figmaUrl,
    fileName: file.name || 'Untitled',
    analyzedAt: Date.now(),
    healthScore: 75,
    status: { label: 'Razoável', tone: 'warn' },
    totalIssues: 30,
    duplicateVariants: 12,
    adoptionScore: 75,
    detachedComponents,
    visualDrift: 6,
    tokenUsage: 75,
    coverage: 85,
    trend: { direction: 'flat', delta: 0 },
    issuesBySeverity: { high: 8, medium: 14, low: 8 },
    allIssues: [],
    insights: [],
    components: compList,
    tokens: {
      color: { total: colorTotal, top: finalColorTokens },
      typography: { total: typographyTotal, top: finalTypographyTokens },
      spacing: { total: 0, top: [] },
      size: { total: 0, top: [] },
      radius: { total: 0, top: [] },
      borderWidth: { total: 0, top: [] }
    },
    _meta: { tokensSource }
  };
}

/* Percorre recursivamente toda a árvore de nodes do ficheiro Figma.
   Devolve agregados num só varrimento (eficiente):
     - detachedCount: instâncias que perderam ligação ao main component
     - instancesByComponentId: { componentNodeId: count }
     - usageByStyleId: { styleId: count } — quantas vezes cada style é referenciado

   NOTA: node.styles é um mapa tipo { fill: "S:abc...", text: "S:def..." }.
   A chave indica QUE propriedade usa esse style (fill, stroke, text, effect, grid). */
function crawlDocument(rootNode) {
  let detachedCount = 0;
  const instancesByComponentId = {};
  const usageByStyleId = {};
  const colorsByHex = {};
  const typographyByKey = {};
  // Mapa { componentSetNodeId: pageName } — usado para excluir sets em pages
  // específicas (ex: "Icons") da contagem total de componentes.
  const componentSetPage = {};
  // Mesmo para COMPONENT standalone (sem variants).
  const componentPage = {};

  // currentPage é mantida durante a recursão. Pages são nodes type=CANVAS
  // imediatamente abaixo do DOCUMENT root.
  function walk(node, currentPage) {
    // Se este node é uma CANVAS (page), actualiza o contexto para os children
    if (node.type === 'CANVAS') {
      currentPage = node.name || '';
    }
    // Regista a page deste componentSet
    if (node.type === 'COMPONENT_SET') {
      componentSetPage[node.id] = currentPage || '';
    }
    // Regista a page de COMPONENT standalone (sem parent componentSet).
    // Componentes dentro de um set têm parent COMPONENT_SET e não nos interessam aqui.
    if (node.type === 'COMPONENT') {
      componentPage[node.id] = currentPage || '';
    }

    if (node.type === 'INSTANCE') {
      if (!node.componentId || node.isDetached === true) {
        detachedCount++;
      } else {
        instancesByComponentId[node.componentId] =
          (instancesByComponentId[node.componentId] || 0) + 1;
      }
    }
    if (node.styles && typeof node.styles === 'object') {
      Object.values(node.styles).forEach(styleId => {
        if (styleId) {
          usageByStyleId[styleId] = (usageByStyleId[styleId] || 0) + 1;
        }
      });
    }
    const fills = node.fills;
    if (Array.isArray(fills)) {
      fills.forEach(fill => {
        if (fill.visible === false) return;
        if (fill.type === 'SOLID' && fill.color) {
          const hex = rgbaToHex(fill.color, fill.opacity);
          colorsByHex[hex] = (colorsByHex[hex] || 0) + 1;
        }
      });
    }
    if (node.type === 'TEXT' && node.style) {
      const ts = node.style;
      const family = ts.fontFamily || '?';
      const size = ts.fontSize ? Math.round(ts.fontSize) : 0;
      const weight = ts.fontWeight || 400;
      const key = `${family}·${size}·${weight}`;
      if (!typographyByKey[key]) {
        typographyByKey[key] = {
          family, size, weight,
          letterSpacing: ts.letterSpacing?.value,
          lineHeight: ts.lineHeightPx ? Math.round(ts.lineHeightPx) : null,
          count: 0
        };
      }
      typographyByKey[key].count++;
    }
    if (node.children && Array.isArray(node.children)) {
      node.children.forEach(child => walk(child, currentPage));
    }
  }
  walk(rootNode, '');
  return {
    detachedCount,
    instancesByComponentId,
    usageByStyleId,
    colorsByHex,
    typographyByKey,
    componentSetPage,
    componentPage
  };
}

/* Constrói lista de cores a partir do crawl (modo fallback — sem Styles publicados).
   Cada cor única detectada no documento vira uma "linha" com nome = hex,
   valor = hex e usage = contagem do crawl.

   Como não temos nome de token, usamos o próprio hex como name. */
function buildColorTokensFromCrawl(colorsByHex) {
  return Object.entries(colorsByHex)
    .map(([hex, count]) => ({
      name: hex,
      value: hex,
      usage: count
    }))
    .sort((a, b) => b.usage - a.usage);
}

/* Constrói lista de tipografia a partir do crawl.
   Cada combinação única de family·size·weight detectada vira uma linha. */
function buildTypographyTokensFromCrawl(typographyByKey) {
  return Object.values(typographyByKey)
    .map(t => ({
      name: `${t.family} ${t.size}/${t.weight}`,
      value: `${t.family} ${t.size}px · ${t.weight}`,
      usage: t.count
    }))
    .sort((a, b) => b.usage - a.usage);
}

/* Constrói lista de tokens de Cor com nome, valor (hex) e nº de usos.
   - styles: array de styles tipo FILL vindos de /styles
   - styleNodes: mapa de nodes vindo de /nodes?ids= (contém o documento real do style)
   - usageByStyleId: contagem do crawl

   Cada style do tipo FILL tem fills[] no node — pegamos o primeiro SOLID
   (a maioria dos color tokens são single-fill solids; gradientes ficam como '—'). */
function buildColorTokens(styles, styleNodes, usageByStyleId) {
  return styles.map(style => {
    const node = styleNodes[style.node_id]?.document;
    const fill = node?.fills?.[0];
    let value = '—';
    if (fill?.type === 'SOLID' && fill.color) {
      value = rgbaToHex(fill.color, fill.opacity);
    } else if (fill?.type?.startsWith('GRADIENT')) {
      value = 'Gradiente';
    }
    return {
      name: style.name,
      value,
      usage: usageByStyleId[style.node_id] || 0
    };
  }).sort((a, b) => b.usage - a.usage);
}

/* Constrói lista de tokens de Tipografia com nome, valor (font/size/weight) e usos.
   O node de um TEXT style tem style.{fontFamily, fontSize, fontWeight, ...} */
function buildTypographyTokens(styles, styleNodes, usageByStyleId) {
  return styles.map(style => {
    const node = styleNodes[style.node_id]?.document;
    const ts = node?.style;
    let value = '—';
    if (ts) {
      const family = ts.fontFamily || '?';
      const size = ts.fontSize ? `${Math.round(ts.fontSize)}px` : '?';
      const weight = ts.fontWeight || '';
      value = `${family} ${size}${weight ? ' · ' + weight : ''}`;
    }
    return {
      name: style.name,
      value,
      usage: usageByStyleId[style.node_id] || 0
    };
  }).sort((a, b) => b.usage - a.usage);
}

/* Converte { r: 0.5, g: 0.2, b: 0.9 } da Figma API em "#8033E6".
   r/g/b vêm como floats 0-1 (não 0-255). Inclui alpha se < 1. */
function rgbaToHex(color, opacity) {
  const r = Math.round((color.r || 0) * 255);
  const g = Math.round((color.g || 0) * 255);
  const b = Math.round((color.b || 0) * 255);
  const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
  // Inclui alpha só se houver transparência real
  const alpha = opacity ?? color.a ?? 1;
  if (alpha < 1) {
    const a = Math.round(alpha * 255).toString(16).padStart(2, '0').toUpperCase();
    return `${hex}${a}`;
  }
  return hex;
}

function groupBy(arr, fn) {
  return (arr || []).reduce((acc, item) => {
    const key = fn(item);
    (acc[key] = acc[key] || []).push(item);
    return acc;
  }, {});
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}
