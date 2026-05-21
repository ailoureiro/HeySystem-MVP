/* =========================================================
   ANALYZE — Netlify Serverless Function
   ---------------------------------------------------------
   Esta função corre nos servidores da Netlify (não no browser).
   Recebe um fileKey do Figma, chama a Figma REST API com o
   token privado, e devolve dados básicos sobre o ficheiro.

   ETAPA 1 (esta versão):
   - Validar input
   - Chamar a Figma API
   - Devolver: nome do ficheiro + nº componentes + nº estilos
     + data de última modificação

   ETAPA 2+ (futuro):
   - Detectar componentes detached, duplicados, etc.
   - Calcular adopção real de tokens
   - Cache para reduzir chamadas à Figma
   ========================================================= */

export default async (req, context) => {

  // -----------------------------------------------------------
  // 1) Só aceitamos POST. Outros métodos → 405.
  // O browser usa POST para enviar o fileKey no body.
  // -----------------------------------------------------------
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Método não permitido' }, 405);
  }

  // -----------------------------------------------------------
  // 2) Extrair o fileKey do body JSON enviado pelo browser.
  // Se o body for inválido, devolvemos 400 (bad request).
  // -----------------------------------------------------------
  let fileKey;
  try {
    const body = await req.json();
    fileKey = body.fileKey;
  } catch {
    return jsonResponse({ error: 'JSON inválido no body' }, 400);
  }

  // Validação básica: o fileKey do Figma é alfanumérico.
  // Isto também protege contra path traversal (ex: "../secret").
  if (!fileKey || typeof fileKey !== 'string' || !/^[A-Za-z0-9]+$/.test(fileKey)) {
    return jsonResponse({ error: 'fileKey inválido' }, 400);
  }

  // -----------------------------------------------------------
  // 3) Ler o token da environment variable.
  // O token NUNCA está hardcoded — vive nas settings da Netlify.
  // Netlify.env.get() é a forma moderna; process.env.FIGMA_TOKEN
  // também funciona (legado).
  // -----------------------------------------------------------
  const token = Netlify.env.get('FIGMA_TOKEN') || process.env.FIGMA_TOKEN;

  if (!token) {
    // Se o token não está configurado, a app não funciona.
    // Devolvemos erro genérico — não revelar detalhes de config.
    console.error('FIGMA_TOKEN não está configurado');
    return jsonResponse({ error: 'Servidor mal configurado' }, 500);
  }

  // -----------------------------------------------------------
  // 4) Chamar a Figma REST API.
  // Endpoint: GET /v1/files/:key
  // Header: X-Figma-Token: <PAT>
  // -----------------------------------------------------------
  let figmaResponse;
  try {
    figmaResponse = await fetch(`https://api.figma.com/v1/files/${fileKey}`, {
      method: 'GET',
      headers: {
        'X-Figma-Token': token
      }
    });
  } catch (err) {
    // Erro de rede (DNS, timeout, etc.)
    console.error('Erro ao contactar Figma:', err);
    return jsonResponse({ error: 'Falha ao contactar Figma' }, 502);
  }

  // -----------------------------------------------------------
  // 5) Tratar respostas de erro da Figma.
  // 403 = token inválido OU sem acesso ao ficheiro
  // 404 = ficheiro não existe
  // 429 = rate limit
  // 5xx = problema do lado da Figma
  // -----------------------------------------------------------
  if (!figmaResponse.ok) {
    const status = figmaResponse.status;
    let message;
    if (status === 403)      message = 'Sem acesso a este ficheiro Figma.';
    else if (status === 404) message = 'Ficheiro não encontrado.';
    else if (status === 429) message = 'Muitos pedidos. Tenta de novo daqui a uns segundos.';
    else                     message = 'A Figma respondeu com erro.';

    return jsonResponse({ error: message, figmaStatus: status }, status);
  }

  // -----------------------------------------------------------
  // 6) Parse do JSON da Figma e transformação para o nosso formato.
  // O ficheiro Figma é gigante — não devolvemos tudo ao browser,
  // só os campos que o dashboard precisa.
  // -----------------------------------------------------------
  let figmaData;
  try {
    figmaData = await figmaResponse.json();
  } catch (err) {
    console.error('Erro a fazer parse do JSON da Figma:', err);
    return jsonResponse({ error: 'Resposta inválida da Figma' }, 502);
  }

  const analysis = transformFigmaData(figmaData);
  return jsonResponse(analysis, 200);
};

// =========================================================
// TRANSFORMAÇÃO: Figma → dados que o dashboard espera.
//
// Conta componentes em DUAS dimensões:
//   1. `figmaFile.components` → inventário top-level (variantes contam 1-a-1)
//   2. Travessia da árvore (`document`) → conta nós tipo COMPONENT e
//      COMPONENT_SET dentro de cada página. Mais fiel ao que o user vê
//      no painel Assets do Figma.
//
// Devolvemos ambos para o frontend poder decidir qual mostrar e
// para conseguirmos diagnosticar discrepâncias.
// =========================================================
function transformFigmaData(figmaFile) {
  // ----- Método 1: Inventário top-level -----
  // figmaFile.components inclui também componentes herdados de libraries
  // externas (`remote: true`) — precisamos de separar.
  const components = figmaFile.components || {};
  const componentsCount = Object.keys(components).length;

  // Local vs Remote
  let localComponentsCount = 0;
  let remoteComponentsCount = 0;
  for (const id in components) {
    if (components[id].remote) remoteComponentsCount++;
    else                       localComponentsCount++;
  }

  const componentSets = figmaFile.componentSets || {};
  const componentSetsCount = Object.keys(componentSets).length;

  // ----- Decomposição dos styles -----
  // styleType: 'FILL' (cor) | 'TEXT' (tipografia) | 'EFFECT' (sombra/blur) | 'GRID' (layout grid)
  // Também separa Local vs Remote (herdado de library externa).
  const styles = figmaFile.styles || {};
  const stylesBreakdown = {
    total:    0,
    byType:   { FILL: 0, TEXT: 0, EFFECT: 0, GRID: 0 },
    byOrigin: { local: 0, remote: 0 }
  };
  for (const id in styles) {
    const style = styles[id];
    stylesBreakdown.total++;
    if (style.styleType && stylesBreakdown.byType.hasOwnProperty(style.styleType)) {
      stylesBreakdown.byType[style.styleType]++;
    }
    if (style.remote) stylesBreakdown.byOrigin.remote++;
    else              stylesBreakdown.byOrigin.local++;
  }
  const stylesCount = stylesBreakdown.total;

  // ----- Método 2: Travessia da árvore -----
  // Percorremos as páginas e contamos nós COMPONENT/COMPONENT_SET reais.
  // Isto reflete melhor o que o user vê no painel Assets.
  const treeStats = walkDocument(figmaFile.document);

  // ----- ETAPA 2: Detecção de componentes detached -----
  // Combina 2 sinais (ver detectDetached) para identificar instâncias
  // que perderam ligação ao componente master.
  const detachedAnalysis = detectDetached(figmaFile);

  // ----- ETAPA 2: Adopção de tokens -----
  // % de elementos visuais (fills/strokes/effects/text) que usam
  // styles do design system vs valores hardcoded.
  // Reaproveita o detector de páginas de documentação.
  const componentNames = new Set();
  for (const id in (figmaFile.components || {})) {
    const name = figmaFile.components[id].name;
    if (name) componentNames.add(name);
  }
  for (const id in (figmaFile.componentSets || {})) {
    const name = figmaFile.componentSets[id].name;
    if (name) componentNames.add(name);
  }
  const isDocPageFn = makeIsDocumentationPage(componentNames);
  const adoptionAnalysis = detectTokenAdoption(figmaFile, isDocPageFn);

  // ----- ETAPA 2: Uso de componentes (3 análises numa só) -----
  // Top usados, não usados, e duplicados potenciais.
  const usageAnalysis = detectComponentUsage(figmaFile);

  return {
    fileName:           figmaFile.name,
    lastModified:       figmaFile.lastModified,
    thumbnailUrl:       figmaFile.thumbnailUrl,

    // Números principais (inventário top-level — inclui remotos)
    totalComponents:    componentsCount,
    totalComponentSets: componentSetsCount,
    tokensTotal:        stylesCount,

    // ETAPA 2 — Detached components (dado REAL)
    detached:           detachedAnalysis.total,
    detachedBreakdown:  {
      byNameMatch:      detachedAnalysis.bySignal1Count,  // SINAL 1
      byOrphanInstance: detachedAnalysis.bySignal2Count   // SINAL 2
    },
    detachedSample:     detachedAnalysis.sample,

    // ETAPA 2 — Token adoption (dado REAL)
    // Percentagens por categoria + overall + contagens absolutas para diagnóstico
    adoption:           adoptionAnalysis,

    // ETAPA 2 — Componentes mais usados / não usados / duplicados (dado REAL)
    componentUsage:     usageAnalysis,
    duplicates:         usageAnalysis.summary.duplicateGroupCount,
    unusedComponentsCount: usageAnalysis.summary.unusedCount,

    // Diagnóstico — decomposição dos styles (tipo + origem)
    stylesBreakdown:    stylesBreakdown,

    // Diagnóstico — separa local vs remoto
    localComponents:    localComponentsCount,
    remoteComponents:   remoteComponentsCount,

    // Diagnóstico — contagens da travessia (alternativa)
    treeComponents:     treeStats.components,
    treeComponentSets:  treeStats.componentSets,
    pagesCount:         treeStats.pagesCount,
    nodesCount:         treeStats.nodesCount,

    // ETAPA 2 vai adicionar mais campos derivados:
    //   detached, duplicates, overrides, healthScore, etc.
  };
}

/* =========================================================
   DETACHED COMPONENTS — detecção real (ETAPA 2)
   ---------------------------------------------------------
   Combina 2 sinais para identificar instâncias que perderam
   a ligação ao seu componente master:

   SINAL 1 — Frames com nome de componente:
     Ao fazer "Detach Instance" no Figma, a instância vira FRAME
     mas mantém o nome (ex: "Button/Primary"). Comparamos cada
     FRAME com a lista de nomes de componentes do ficheiro —
     se bater certo, é forte indício de detached.

   SINAL 2 — Instâncias órfãs:
     Nós INSTANCE cujo componentId aponta para um componente
     que já não existe no ficheiro (foi apagado mas a instância
     ficou). Estes são detached por definição.

   Devolvemos contagem + amostra (até 10 ocorrências) para o
   dashboard poder listar exemplos concretos.
   ========================================================= */
/* Helper: detecta se uma página é de documentação/exemplos.
   Usado tanto pelo detector de detached como pelo de adopção
   de tokens, para excluir páginas que legitimamente têm valores
   hardcoded ou frames com nomes de componentes. */
function makeIsDocumentationPage(componentNames) {
  return function isDocumentationPage(pageName) {
    if (!pageName) return false;
    const normalized = pageName.trim().toLowerCase();

    // Sinal 1: nome (trimmed) bate certo com um componente
    if (componentNames.has(pageName.trim())) return true;

    // Sinal 2: keywords de documentação
    const docKeywords = [
      'cover', 'docs', 'documentation', 'doc ', '(doc', '[doc',
      'examples', 'specs', 'guidelines', 'playground', 'sandbox',
      'archive', 'archived', 'draft', 'wip', '(wip', '[wip',
      'reference', 'references', 'usage', 'anatomy'
    ];
    for (const kw of docKeywords) {
      if (normalized.includes(kw)) return true;
    }

    // Sinal 3: começa com emoji (heurística de "página especial")
    const firstChar = pageName.trim().charAt(0);
    if (firstChar && !/[a-z0-9]/i.test(firstChar)) return true;

    return false;
  };
}

function detectDetached(figmaFile) {
  // 1. Construir set de nomes de componentes existentes — lookup O(1)
  // Inclui também os component sets (parents de variantes)
  const componentNames = new Set();
  const componentIds   = new Set();
  for (const id in (figmaFile.components || {})) {
    componentIds.add(id);
    const name = figmaFile.components[id].name;
    if (name) componentNames.add(name);
  }
  for (const id in (figmaFile.componentSets || {})) {
    componentIds.add(id);
    const name = figmaFile.componentSets[id].name;
    if (name) componentNames.add(name);
  }

  // Helper extraído (também usado por detectTokenAdoption)
  const isDocumentationPage = makeIsDocumentationPage(componentNames);

  // 2. Percorrer árvore e procurar os 2 sinais
  const detached = {
    bySignal1: [],   // frames com nome de componente
    bySignal2: [],   // instâncias órfãs
    total: 0
  };

  /* FILTROS para reduzir falsos positivos do Sinal 1:

     Um frame só é "suspeito de detached" se:
     A) Não está dentro de outro componente (frames internos de
        componentes vão ter nomes técnicos parecidos com componentes)
     B) Não está dentro de uma INSTANCE (filhos de instâncias
        podem reflectir estrutura interna do componente)
     C) Não está dentro de um COMPONENT_SET (frames de variantes)

     Implementação: passamos `insideComponent` como flag durante
     a travessia, e só consideramos detached se a flag for false. */

  function visit(node, pagePath, insideComponent, isDocPage) {
    if (!node) return;

    // Tipos que "contaminam" os filhos — qualquer frame lá dentro
    // não pode ser considerado detached pelo Sinal 1.
    const isComponentContext = (
      node.type === 'COMPONENT' ||
      node.type === 'COMPONENT_SET' ||
      node.type === 'INSTANCE'
    );

    // SINAL 1: FRAME com nome de componente,
    // MAS apenas se não estiver:
    //   - dentro de outro componente
    //   - numa página de documentação
    if (
      node.type === 'FRAME' &&
      componentNames.has(node.name) &&
      !insideComponent &&
      !isDocPage
    ) {
      detached.bySignal1.push({
        name: node.name,
        nodeId: node.id,
        page: pagePath,
        signal: 'frame-with-component-name'
      });
    }

    // SINAL 2: INSTANCE órfã (componentId não existe no ficheiro)
    if (node.type === 'INSTANCE' && node.componentId && !componentIds.has(node.componentId)) {
      detached.bySignal2.push({
        name: node.name,
        nodeId: node.id,
        page: pagePath,
        componentId: node.componentId,
        signal: 'orphan-instance'
      });
    }

    // Recursão para filhos
    if (Array.isArray(node.children)) {
      const childInsideComponent = insideComponent || isComponentContext;
      for (const child of node.children) {
        // Ao entrar numa CANVAS (página), actualizamos path E avaliamos
        // se é página de documentação.
        let nextPath  = pagePath;
        let nextIsDoc = isDocPage;
        if (node.type === 'CANVAS') {
          nextPath  = node.name;
          nextIsDoc = isDocumentationPage(node.name);
        }
        visit(child, nextPath, childInsideComponent, nextIsDoc);
      }
    }
  }

  visit(figmaFile.document, 'root', false, false);

  detached.total = detached.bySignal1.length + detached.bySignal2.length;

  // Amostra para o dashboard: até 10 exemplos, combinando ambos os sinais
  const sample = [...detached.bySignal1, ...detached.bySignal2].slice(0, 10);

  return {
    total: detached.total,
    bySignal1Count: detached.bySignal1.length,
    bySignal2Count: detached.bySignal2.length,
    sample: sample
  };
}

/* =========================================================
   TOKEN ADOPTION — % de elementos que usam tokens vs hardcoded
   ---------------------------------------------------------
   "Token" aqui significa QUALQUER uma destas duas coisas:

     A) Style legado (figmaFile.styles) — aplicado via
        node.styles.{fill|stroke|effect|fills}
     B) Variable moderno (lançado em 2024) — aplicado via
        node.boundVariables.* OU
        node.fills[i].boundVariables.color
        node.strokes[i].boundVariables.color
        node.effects[i].boundVariables.color

   Variables podem cobrir muito mais que Styles: cor, spacing,
   radius, tamanho de fonte, etc. Por isso medimos várias
   categorias separadas.

   Categorias:
     - fill:    cores de preenchimento
     - stroke:  cores de borda
     - text:    cor + tamanho de fonte dos nós TEXT
     - effect:  sombras, blurs
     - radius:  cornerRadius dos frames/rectângulos
     - spacing: padding + itemSpacing dos frames com auto-layout

   Exclusões (para evitar duplo-counting / falsos positivos):
     - Nós dentro de INSTANCE (herdam do master)
     - Páginas de documentação
   ========================================================= */
function detectTokenAdoption(figmaFile, isDocPageFn) {
  const stats = {
    fill:    { withToken: 0, total: 0 },
    stroke:  { withToken: 0, total: 0 },
    text:    { withToken: 0, total: 0 },
    effect:  { withToken: 0, total: 0 },
    radius:  { withToken: 0, total: 0 },
    spacing: { withToken: 0, total: 0 }
  };

  // ----- Helpers de detecção -----

  // Verifica se um fill/stroke individual tem Variable ligada
  function paintHasVariable(paint) {
    return !!(paint && paint.boundVariables && paint.boundVariables.color);
  }

  // Verifica se um effect tem Variable ligada (ex: cor da sombra)
  function effectHasVariable(effect) {
    return !!(effect && effect.boundVariables && (effect.boundVariables.color || effect.boundVariables.radius));
  }

  // Fills visíveis e sólidos (ignora transparentes, hidden, gradientes, imagens)
  function isVisibleSolidPaint(paint) {
    if (!paint || paint.visible === false) return false;
    if (paint.type !== 'SOLID') return false;
    if (paint.opacity === 0) return false;
    if (paint.color && paint.color.a === 0) return false;
    return true;
  }

  function isVisibleEffect(effect) {
    return effect && effect.visible !== false;
  }

  // ----- Lógica por categoria -----

  // FILL: itera os fills do nó. Conta cada fill visível & sólido como
  // uma "decisão". Tem token se EITHER node.styles.fill EITHER
  // o próprio fill tem boundVariables.color.
  function processFills(node, category) {
    if (!Array.isArray(node.fills)) return;

    const nodeHasFillStyle = !!(node.styles && (node.styles.fill || node.styles.fills));

    for (const fill of node.fills) {
      if (!isVisibleSolidPaint(fill)) continue;
      stats[category].total++;
      // Tem token se: aplicou Style globalmente OU se este fill tem Variable
      if (nodeHasFillStyle || paintHasVariable(fill)) {
        stats[category].withToken++;
      }
    }
  }

  function processStrokes(node) {
    if (!Array.isArray(node.strokes)) return;
    const nodeHasStrokeStyle = !!(node.styles && (node.styles.stroke || node.styles.strokes));

    for (const stroke of node.strokes) {
      if (!isVisibleSolidPaint(stroke)) continue;
      stats.stroke.total++;
      if (nodeHasStrokeStyle || paintHasVariable(stroke)) {
        stats.stroke.withToken++;
      }
    }
  }

  function processEffects(node) {
    if (!Array.isArray(node.effects)) return;
    const nodeHasEffectStyle = !!(node.styles && (node.styles.effect || node.styles.effects));

    for (const effect of node.effects) {
      if (!isVisibleEffect(effect)) continue;
      stats.effect.total++;
      if (nodeHasEffectStyle || effectHasVariable(effect)) {
        stats.effect.withToken++;
      }
    }
  }

  // TEXT: extra para nós TEXT — verificar também variables ligados a tamanho
  function processText(node) {
    if (node.type !== 'TEXT') return;
    // Tamanho de fonte (uma decisão de design separada)
    if (node.style && typeof node.style.fontSize === 'number') {
      stats.text.total++;
      const hasTextStyle = !!(node.styles && (node.styles.text || node.styles.fontSize));
      const hasFontSizeVar = !!(node.boundVariables && node.boundVariables.fontSize);
      if (hasTextStyle || hasFontSizeVar) {
        stats.text.withToken++;
      }
    }
  }

  // RADIUS: nós com cornerRadius definido (>0) qualificam-se
  function processRadius(node) {
    // Frames e rectangles com radius definido
    if (typeof node.cornerRadius === 'number' && node.cornerRadius > 0) {
      stats.radius.total++;
      const hasRadiusVar = !!(node.boundVariables && node.boundVariables.cornerRadius);
      if (hasRadiusVar) stats.radius.withToken++;
    }
    // rectangleCornerRadii (cada canto separado) — conta como 4 decisões
    if (Array.isArray(node.rectangleCornerRadii)) {
      for (let i = 0; i < node.rectangleCornerRadii.length; i++) {
        if (node.rectangleCornerRadii[i] > 0) {
          stats.radius.total++;
          const cornerKeys = ['topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius'];
          const hasCornerVar = !!(node.boundVariables && node.boundVariables[cornerKeys[i]]);
          if (hasCornerVar) stats.radius.withToken++;
        }
      }
    }
  }

  // SPACING: padding + itemSpacing dos frames com auto-layout
  function processSpacing(node) {
    // Auto-layout só está activo em frames com layoutMode definido
    if (!node.layoutMode || node.layoutMode === 'NONE') return;

    const spacingProps = [
      'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom',
      'itemSpacing', 'counterAxisSpacing'
    ];
    for (const prop of spacingProps) {
      if (typeof node[prop] === 'number' && node[prop] > 0) {
        stats.spacing.total++;
        const hasVar = !!(node.boundVariables && node.boundVariables[prop]);
        if (hasVar) stats.spacing.withToken++;
      }
    }
  }

  // ----- Travessia da árvore -----
  function visit(node, insideInstance, isDocPage) {
    if (!node) return;

    const shouldCount = !insideInstance && !isDocPage;

    if (shouldCount) {
      // Para FILLS: separa text de não-text por convenção
      const fillCategory = node.type === 'TEXT' ? 'text' : 'fill';
      processFills(node, fillCategory);
      processStrokes(node);
      processEffects(node);
      processText(node);
      processRadius(node);
      processSpacing(node);
    }

    // Recursão
    if (Array.isArray(node.children)) {
      const childInsideInstance = insideInstance || node.type === 'INSTANCE';
      for (const child of node.children) {
        let nextIsDoc = isDocPage;
        if (node.type === 'CANVAS') {
          nextIsDoc = isDocPageFn(node.name);
        }
        visit(child, childInsideInstance, nextIsDoc);
      }
    }
  }

  visit(figmaFile.document, false, false);

  // Percentagens
  const pct = (s) => s.total === 0 ? null : Math.round((s.withToken / s.total) * 100);

  const byCategory = {
    fill:    pct(stats.fill),
    stroke:  pct(stats.stroke),
    text:    pct(stats.text),
    effect:  pct(stats.effect),
    radius:  pct(stats.radius),
    spacing: pct(stats.spacing)
  };

  // Overall: média ponderada por nº de decisões em cada categoria
  let totalDecisions = 0, totalWithToken = 0;
  for (const cat in stats) {
    totalDecisions += stats[cat].total;
    totalWithToken += stats[cat].withToken;
  }
  const overall = totalDecisions === 0 ? 0 : Math.round((totalWithToken / totalDecisions) * 100);

  return {
    overall,
    byCategory,
    totals: {
      fillsWithToken:    stats.fill.withToken,
      fillsTotal:        stats.fill.total,
      strokesWithToken:  stats.stroke.withToken,
      strokesTotal:      stats.stroke.total,
      textsWithToken:    stats.text.withToken,
      textsTotal:        stats.text.total,
      effectsWithToken:  stats.effect.withToken,
      effectsTotal:      stats.effect.total,
      radiusWithToken:   stats.radius.withToken,
      radiusTotal:       stats.radius.total,
      spacingWithToken:  stats.spacing.withToken,
      spacingTotal:      stats.spacing.total
    }
  };
}

/* =========================================================
   COMPONENT USAGE — 3 análises numa só travessia
   ---------------------------------------------------------
   Percorre a árvore uma vez e produz:
     1. Top componentes mais usados (com contagem de instâncias)
     2. Componentes nunca usados (zero instâncias)
     3. Componentes potencialmente duplicados (heurística)

   Eficiente: O(N) na árvore + O(C²) na detecção de duplicados,
   onde C = número de componentes (centenas, não milhares).
   ========================================================= */
function detectComponentUsage(figmaFile) {
  // ----- 1. Construir mapa de componentes (id → metadata) -----
  // Inclui componentes individuais E component sets.
  // Para variantes (componente dentro de component set),
  // agregamos a contagem ao set parente — ver lógica abaixo.

  const components = figmaFile.components || {};
  const componentSets = figmaFile.componentSets || {};

  // Mapa principal: nodeId → { name, instanceCount, parentSetId, dimensions, remote }
  const componentMap = {};

  for (const id in components) {
    const c = components[id];
    componentMap[id] = {
      id,
      name: c.name || '(sem nome)',
      instanceCount: 0,
      parentSetId: c.componentSetId || null,
      remote: !!c.remote,
      type: 'COMPONENT'
    };
  }
  for (const id in componentSets) {
    const cs = componentSets[id];
    componentMap[id] = {
      id,
      name: cs.name || '(sem nome)',
      instanceCount: 0,
      parentSetId: null,
      remote: !!cs.remote,
      type: 'COMPONENT_SET',
      variants: []  // preenchido abaixo
    };
  }
  // Liga variantes aos seus sets
  for (const id in componentMap) {
    const c = componentMap[id];
    if (c.parentSetId && componentMap[c.parentSetId]) {
      componentMap[c.parentSetId].variants.push(id);
    }
  }

  // Também precisamos das dimensões reais de cada componente
  // (para detecção de duplicados). Estas vivem na árvore, não
  // no objecto figmaFile.components. Vamos buscá-las na travessia.

  // ----- 2. Travessia: contar instâncias e capturar dimensões -----
  function visit(node) {
    if (!node) return;

    // INSTANCE → incrementar contagem no componente correspondente
    if (node.type === 'INSTANCE' && node.componentId) {
      const targetId = node.componentId;
      if (componentMap[targetId]) {
        componentMap[targetId].instanceCount++;
        // Se a instância aponta para uma variante, contar também no set
        const parent = componentMap[targetId].parentSetId;
        if (parent && componentMap[parent]) {
          componentMap[parent].instanceCount++;
        }
      }
    }

    // COMPONENT / COMPONENT_SET → capturar dimensões reais
    if ((node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') && componentMap[node.id]) {
      if (node.absoluteBoundingBox) {
        componentMap[node.id].width  = Math.round(node.absoluteBoundingBox.width);
        componentMap[node.id].height = Math.round(node.absoluteBoundingBox.height);
      }
    }

    // Recursão
    if (Array.isArray(node.children)) {
      for (const child of node.children) visit(child);
    }
  }
  visit(figmaFile.document);

  // ----- 3. TOP USED — ordenar por contagem descendente -----
  // Para a lista do dashboard, preferimos COMPONENT_SETs (uma linha
  // por "componente lógico") em vez de variantes individuais. Mas
  // mantemos COMPONENTs soltos (sem parentSet) também.
  const topUsedCandidates = Object.values(componentMap).filter(c => {
    // Inclui apenas componentes locais (não remotos) para a lista
    if (c.remote) return false;
    // Exclui variantes — já contadas no set parente
    if (c.parentSetId) return false;
    return true;
  });

  const topUsed = topUsedCandidates
    .map(c => ({
      id: c.id,
      name: c.name,
      instanceCount: c.instanceCount,
      type: c.type,
      variants: c.variants ? c.variants.length : 0
    }))
    .sort((a, b) => b.instanceCount - a.instanceCount)
    .slice(0, 50);  // top 50 — frontend pode mostrar 20, 30, etc.

  // ----- 4. UNUSED — componentes com 0 instâncias -----
  // Mesma lógica: ignorar remotos e variantes individuais.
  const unused = topUsedCandidates
    .filter(c => c.instanceCount === 0)
    .map(c => ({
      id: c.id,
      name: c.name,
      type: c.type
    }))
    .slice(0, 30);  // até 30 candidatos a deprecation

  // ----- 5. DUPLICATES — heurística baseada em sufixos e dimensões -----
  // Sinais que indicam potencial duplicado:
  //   A) Sufixo suspeito (-2, copy, " 2", " (1)", etc.)
  //   B) Mesmas dimensões + nome muito parecido
  //
  // Estratégia: agrupar componentes por nome "normalizado".
  // Se 2+ caem no mesmo grupo → suspeitos de duplicado.

  /* Detecção de duplicados — versão conservadora.
     Em vez de normalizar nomes agressivamente (causa muitos falsos
     positivos com "Heading 1/2/3", "Icon 16/24/32"), exigimos
     sinais EXPLÍCITOS de cópia:

       Sinal forte (suficiente sozinho):
         - sufixo " copy", "copy 2"
         - sufixo "(1)", "(2)"
       Sinal fraco (precisa de confirmação por dimensões iguais):
         - sufixo "-2", " 2" (pode ser variante legítima)

     Resultado: muito mais conservador, evitamos contar variantes
     numeradas legítimas como duplicados. */

  // Devolve { normalized, signal: 'strong' | 'weak' | null }
  function analyzeName(name) {
    const original = name;

    // Sinal forte: " copy" ou " copy 2"
    let m = original.match(/^(.+?)\s*[-_]?\s*copy(\s*\d*)?\s*$/i);
    if (m && m[1].trim()) return { normalized: m[1].trim().toLowerCase(), signal: 'strong' };

    // Sinal forte: "(1)", "(2)"
    m = original.match(/^(.+?)\s*\(\d+\)\s*$/);
    if (m && m[1].trim()) return { normalized: m[1].trim().toLowerCase(), signal: 'strong' };

    // Sinal fraco: "Name-2", "Name_3" (pode ser variante legítima)
    m = original.match(/^(.+?)\s*[-_]\s*\d+\s*$/);
    if (m && m[1].trim()) return { normalized: m[1].trim().toLowerCase(), signal: 'weak' };

    // Sinal fraco: "Name 2" (espaço + número no fim)
    // CUIDADO: isto pega em "Heading 2" → tratamos como fraco para exigir dimensões
    m = original.match(/^(.+?)\s+\d+\s*$/);
    if (m && m[1].trim()) return { normalized: m[1].trim().toLowerCase(), signal: 'weak' };

    return { normalized: null, signal: null };
  }

  // Agrupa apenas componentes que TÊM sinal de cópia + um "irmão" sem sinal
  // (o "irmão" é o componente "original" do qual estes seriam cópias).
  const originalsByNormalized = {};       // nome → componente "original" (sem sinal)
  const candidatesByNormalized = {};      // nome → [cópias suspeitas com sinal]

  for (const c of topUsedCandidates) {
    const { normalized, signal } = analyzeName(c.name);
    if (signal === null) {
      // É um candidato a "original" — guardamos pelo nome em lowercase
      const key = c.name.toLowerCase();
      if (!originalsByNormalized[key]) originalsByNormalized[key] = c;
    } else if (normalized) {
      if (!candidatesByNormalized[normalized]) candidatesByNormalized[normalized] = [];
      candidatesByNormalized[normalized].push({ component: c, signal });
    }
  }

  // Filtra: só consideramos duplicado se existir "original" com o mesmo nome
  // normalizado, OU se houver 2+ cópias suspeitas entre si.
  const duplicateGroups = [];

  /* Helper: detecta se um grupo é uma SÉRIE NUMÉRICA SEQUENCIAL legítima.
     Ex: calendar-day-1, calendar-day-2, ..., calendar-day-31 (dias do mês)
     Ex: icon-step-01, icon-step-02, icon-step-03 (steps numerados)
     Ex: avatar-1, avatar-2, ..., avatar-20 (avatares numerados)

     Estes NÃO são duplicados — são variações intencionais.

     Critério: 3+ membros do grupo têm sufixos numéricos distintos
     formando uma sequência (ex: 1,2,3 ou 1,3,5 com ≥3 valores únicos).
     Se sim, o grupo é uma série, não duplicado. */
  function isSequentialSeries(members) {
    if (members.length < 3) return false;  // 2 elementos não fazem série

    // Extrai número do final do nome (suporta "-1", " 1", "_1", "(1)")
    const numbers = members.map(c => {
      const m = c.name.match(/[-_\s\(](\d+)\)?\s*$/);
      return m ? parseInt(m[1], 10) : null;
    });

    // Todos têm número? (se um falhar, não é série coerente)
    if (numbers.some(n => n === null)) return false;

    // Pelo menos 3 valores distintos
    const unique = new Set(numbers);
    if (unique.size < 3) return false;

    // Os números devem cobrir uma gama coerente
    // (ex: 1-5 ou 1,2,3,4,5,...,31). Não basta 1, 1000, 5000.
    const sorted = [...unique].sort((a, b) => a - b);
    const range = sorted[sorted.length - 1] - sorted[0];
    // Densidade: pelo menos 50% dos números do intervalo estão presentes
    // (1,2,3,4,5 → range 4, 5 únicos → 5/(4+1) = 100% ✓)
    // (1,5,99 → range 98, 3 únicos → 3/99 = 3% ✗)
    const density = unique.size / (range + 1);
    return density >= 0.5;
  }

  for (const norm in candidatesByNormalized) {
    const copies = candidatesByNormalized[norm];
    const original = originalsByNormalized[norm];

    // Lista final do grupo: original (se existir) + cópias suspeitas
    const groupMembers = original ? [original, ...copies.map(c => c.component)]
                                  : copies.map(c => c.component);

    if (groupMembers.length < 2) continue;

    // Excluir séries sequenciais legítimas (calendar-day-1, icon-step-01, etc.)
    if (isSequentialSeries(groupMembers)) continue;

    // Sinal extra de confiança: dimensões iguais
    const widths  = groupMembers.map(c => c.width).filter(w => w);
    const heights = groupMembers.map(c => c.height).filter(h => h);
    const sameDimensions = widths.length >= 2
                         && widths.every(w => w === widths[0])
                         && heights.every(h => h === heights[0]);

    // Regra de aceitação final:
    //   - se há sinal FORTE em alguma cópia → aceita sempre
    //   - se só há sinais fracos → exige dimensões iguais OU presença do "original"
    const hasStrongSignal = copies.some(c => c.signal === 'strong');
    const accept = hasStrongSignal || (sameDimensions && original) || (sameDimensions && copies.length >= 2);

    if (!accept) continue;

    duplicateGroups.push({
      normalizedName: norm,
      components: groupMembers.map(c => ({
        id: c.id,
        name: c.name,
        instanceCount: c.instanceCount,
        width: c.width,
        height: c.height
      })),
      signals: {
        sameDimensions,
        hasStrongSignal
      }
    });
  }

  // ----- 6. CATEGORIES — agrupar componentes por prefixo de nome -----
  // Ex: "Button/Primary" e "Button/Secondary" → categoria "Button"
  const categoryCount = {};
  for (const c of topUsedCandidates) {
    const category = c.name.split('/')[0].trim() || 'Outros';
    if (!categoryCount[category]) categoryCount[category] = { count: 0, totalInstances: 0 };
    categoryCount[category].count++;
    categoryCount[category].totalInstances += c.instanceCount;
  }
  const categories = Object.entries(categoryCount)
    .map(([name, stats]) => ({ name, ...stats }))
    .sort((a, b) => b.totalInstances - a.totalInstances);

  return {
    topUsed,              // top 50 mais usados
    unused,               // até 30 não usados
    duplicateGroups,      // grupos de potenciais duplicados
    categories,           // agregação por prefixo "Button/", "Card/", etc.
    summary: {
      totalLocalComponents:    topUsedCandidates.length,
      unusedCount:             topUsedCandidates.filter(c => c.instanceCount === 0).length,
      duplicateGroupCount:     duplicateGroups.length,
      duplicateComponentCount: duplicateGroups.reduce((sum, g) => sum + g.components.length, 0),
      // Total de instâncias é útil para contexto
      totalInstances:          topUsedCandidates.reduce((sum, c) => sum + c.instanceCount, 0)
    }
  };
}

/* Percorre recursivamente a árvore do documento Figma e conta:
   - Páginas (top-level CANVAS nodes)
   - Componentes (COMPONENT)
   - Component Sets (COMPONENT_SET)
   - Total de nós (útil para o "Analisados X nós" do dashboard) */
function walkDocument(document) {
  let components = 0;
  let componentSets = 0;
  let pagesCount = 0;
  let nodesCount = 0;

  function visit(node) {
    if (!node) return;
    nodesCount++;
    if (node.type === 'COMPONENT')      components++;
    if (node.type === 'COMPONENT_SET')  componentSets++;
    if (node.type === 'CANVAS')         pagesCount++;
    if (Array.isArray(node.children)) {
      for (const child of node.children) visit(child);
    }
  }

  visit(document);
  return { components, componentSets, pagesCount, nodesCount };
}

// =========================================================
// Helper: cria uma Response JSON com headers consistentes.
// Centralizar evita duplicação e garante content-type correcto.
// =========================================================
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // CORS — só importante se o frontend viver noutro domínio.
      // No nosso caso (mesmo domínio Netlify) é redundante mas inofensivo.
      'Access-Control-Allow-Origin': '*'
    }
  });
}
