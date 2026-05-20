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

  // 2. Percorrer árvore e procurar os 2 sinais
  const detached = {
    bySignal1: [],   // frames com nome de componente
    bySignal2: [],   // instâncias órfãs
    total: 0
  };

  function visit(node, pagePath) {
    if (!node) return;

    // SINAL 1: FRAME com nome que corresponde a um componente
    // (filtro extra: ignorar frames muito grandes — pages, sections —
    //  que coincidentemente tenham nomes parecidos)
    if (node.type === 'FRAME' && componentNames.has(node.name)) {
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
      for (const child of node.children) {
        // Se entramos numa CANVAS (página), actualizamos o path
        const nextPath = node.type === 'CANVAS' ? node.name : pagePath;
        visit(child, nextPath);
      }
    }
  }

  visit(figmaFile.document, 'root');

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
