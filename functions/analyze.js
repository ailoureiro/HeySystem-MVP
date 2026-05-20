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
// Por agora, ETAPA 1 — apenas o básico. Depois acrescentamos
// detecção de detached, duplicados, etc.
// =========================================================
function transformFigmaData(figmaFile) {
  // figmaFile.components → objecto com TODOS os componentes da library
  // (incluindo variantes). Cada chave é o nodeId.
  const components = figmaFile.components || {};
  const componentsCount = Object.keys(components).length;

  // figmaFile.styles → estilos (cor, texto, efeitos) definidos no ficheiro.
  // Equivalente aos "tokens" do design system.
  const styles = figmaFile.styles || {};
  const stylesCount = Object.keys(styles).length;

  // figmaFile.componentSets → grupos de variantes (ex: Button com size + variant).
  // Útil para perceber a "modularidade" do sistema.
  const componentSets = figmaFile.componentSets || {};
  const componentSetsCount = Object.keys(componentSets).length;

  // Devolve um objecto bem definido — o browser sabe exactamente
  // que campos esperar. Esta é a "API contract" do nosso backend.
  return {
    fileName:          figmaFile.name,
    lastModified:      figmaFile.lastModified,    // ISO 8601 timestamp
    thumbnailUrl:      figmaFile.thumbnailUrl,
    totalComponents:   componentsCount,
    totalComponentSets: componentSetsCount,
    tokensTotal:       stylesCount,
    // ETAPA 2 vai adicionar mais campos derivados:
    //   detached, duplicates, overrides, healthScore, etc.
  };
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
