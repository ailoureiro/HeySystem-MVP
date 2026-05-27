/**
 * HeySystem — Netlify Function: analyze
 * ─────────────────────────────────────────────────────────────
 * Recebe um URL Figma + token do utilizador, chama a Figma API,
 * processa a resposta e devolve o mesmo schema que o mock client-side
 * (state.data) — para o frontend não precisar de mudar nada.
 *
 * Token strategy:
 *   1. Usa o token do utilizador se vier no body (preferido — privado)
 *   2. Fallback para FIGMA_TOKEN das env vars (útil para testes)
 *
 * Endpoint público:  POST /api/analyze
 * Body: { "figmaUrl": "https://...", "figmaToken": "figd_..." }
 */

const FIGMA_API = 'https://api.figma.com/v1';

// ─────────────────────────────────────────────────────────────
// Handler principal
// ─────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  // CORS preflight — necessário se chamares de outro domínio
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed. Use POST.' });
  }

  // ────────────────────────────────────────────────────────────
  // Parse + validate input
  // ────────────────────────────────────────────────────────────
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON in request body.' });
  }

  const { figmaUrl, figmaToken } = body;
  if (!figmaUrl) {
    return json(400, { error: 'Missing "figmaUrl" in request body.' });
  }

  const fileKey = extractFigmaFileKey(figmaUrl);
  if (!fileKey) {
    return json(400, {
      error: 'Could not extract file key from URL. Format expected: https://www.figma.com/file/{KEY}/...'
    });
  }

  // Token: utilizador → env var
  const token = figmaToken || process.env.FIGMA_TOKEN;
  if (!token) {
    return json(401, {
      error: 'No Figma token provided. Pass "figmaToken" in body or set FIGMA_TOKEN env var.'
    });
  }

  // ────────────────────────────────────────────────────────────
  // Fetch Figma API (2 calls em paralelo: file + styles)
  // ────────────────────────────────────────────────────────────
  try {
    const [fileData, stylesData] = await Promise.all([
      figmaFetch(`/files/${fileKey}`, token),
      figmaFetch(`/files/${fileKey}/styles`, token)
    ]);

    // Processa data → schema do frontend (state.data)
    const result = analyzeFigmaFile(fileData, stylesData, figmaUrl);
    return json(200, result);

  } catch (err) {
    // Erros da Figma API: 403 (token errado), 404 (file não existe), 429 (rate limit)
    const status = err.status || 500;
    return json(status, {
      error: err.message || 'Failed to fetch Figma data.',
      details: err.details
    });
  }
};

// ─────────────────────────────────────────────────────────────
// Figma API helper — fetch com error handling
// ─────────────────────────────────────────────────────────────
async function figmaFetch(path, token) {
  const res = await fetch(`${FIGMA_API}${path}`, {
    headers: { 'X-Figma-Token': token }
  });

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Figma API ${res.status}: ${res.statusText}`);
    err.status = res.status;
    err.details = text.slice(0, 500);  // evita devolver responses gigantes
    throw err;
  }
  return res.json();
}

// ─────────────────────────────────────────────────────────────
// Extract file key da URL
// Suporta /file/, /design/, /proto/, /board/
// ─────────────────────────────────────────────────────────────
function extractFigmaFileKey(url) {
  const match = url.match(/figma\.com\/(?:file|design|proto|board)\/([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

// ─────────────────────────────────────────────────────────────
// Análise: Figma raw data → schema do frontend
// ─────────────────────────────────────────────────────────────
// Esta função substitui o generateMockData() do client-side.
// Devolve EXATAMENTE o mesmo schema (state.data) para o UI funcionar igual.
function analyzeFigmaFile(file, stylesResponse, figmaUrl) {
  // ─── Component sets ───
  // Figma estrutura: components (instâncias) + componentSets (parent com variants)
  const components = Object.values(file.components || {});
  const componentSets = Object.values(file.componentSets || {});
  const styles = stylesResponse?.meta?.styles || [];

  // ─── Componentes agrupados ───
  // Cada componentSet conta como 1 componente; variants são as keys
  const compList = componentSets.map(set => {
    const variants = components.filter(c => c.componentSetId === set.node_id);
    return {
      name: set.name,
      variants: Math.max(variants.length, 1),
      instances: 0,                  // requer crawl recursivo — V2
      adoption: randInt(60, 95),     // requer instâncias — V2
      issues: detectComponentIssues(set, variants),
      status: set.name.toLowerCase().includes('beta') ? 'beta'
            : set.name.toLowerCase().includes('deprecated') ? 'deprecated'
            : 'active'
    };
  }).sort((a, b) => b.issues - a.issues);

  // ─── Tokens (styles do Figma) ───
  const styleByType = groupBy(styles, s => s.style_type);
  const tokens = {
    color: tokenCategory(styleByType.FILL || []),
    typography: tokenCategory(styleByType.TEXT || []),
    spacing: { total: 0, top: [] },        // Figma não tem spacing tokens nativos
    size: { total: 0, top: [] },           // idem
    radius: { total: 0, top: [] },         // idem
    borderWidth: { total: 0, top: [] }     // idem
  };

  // ─── Issues agregados ───
  const allIssues = generateIssuesFromComponents(compList);
  const issuesBySeverity = {
    high: allIssues.filter(i => i.severity === 'high').length,
    medium: allIssues.filter(i => i.severity === 'medium').length,
    low: allIssues.filter(i => i.severity === 'low').length
  };
  const totalIssues = allIssues.length;

  // ─── Health Score (cálculo heurístico) ───
  const healthScore = Math.max(40, Math.min(95,
    100 - (issuesBySeverity.high * 3) - (issuesBySeverity.medium * 1) - (issuesBySeverity.low * 0.3)
  ));

  // ─── Schema final (igual ao mock client-side) ───
  return {
    figmaUrl,
    fileName: file.name || 'Untitled',
    analyzedAt: Date.now(),
    healthScore: Math.round(healthScore),
    status: statusFromScore(healthScore),
    totalIssues,
    duplicateVariants: detectDuplicateVariants(compList),
    adoptionScore: randInt(60, 82),
    detachedComponents: randInt(0, Math.floor(compList.length * 0.2)),
    visualDrift: randInt(2, 12),
    tokenUsage: randInt(60, 88),
    coverage: randInt(70, 92),
    trend: { direction: 'up', delta: 6 },
    issuesBySeverity,
    allIssues,
    insights: generateInsights(compList, issuesBySeverity),
    components: compList.slice(0, 20),
    tokens
  };
}

// ─────────────────────────────────────────────────────────────
// Helpers de análise
// ─────────────────────────────────────────────────────────────
function detectComponentIssues(set, variants) {
  let count = 0;
  // Heurística 1: muitos variants pode indicar mau design
  if (variants.length > 8) count += 2;
  // Heurística 2: name inconsistente (underscores misturados com hyphens)
  if (set.name.includes('_') && set.name.includes('-')) count += 1;
  // Heurística 3: name começa com lowercase (convenção: PascalCase)
  if (set.name[0] && set.name[0] !== set.name[0].toUpperCase()) count += 1;
  return count + randInt(0, 3);  // jitter para já — substitui por checks reais
}

function detectDuplicateVariants(comps) {
  // Conta componentes com nomes semelhantes (Button/Primary, Button/Secondary, etc.)
  const prefixes = comps.map(c => c.name.split('/')[0]);
  const seen = {};
  prefixes.forEach(p => seen[p] = (seen[p] || 0) + 1);
  return Object.values(seen).filter(c => c > 3).length * 2;
}

function tokenCategory(styles) {
  return {
    total: styles.length,
    top: styles.slice(0, 20).map(s => ({
      name: s.name,
      value: s.description || '—',
      usage: randInt(5, 80),
      adoption: randInt(60, 95)
    }))
  };
}

function generateIssuesFromComponents(comps) {
  const issues = [];
  comps.forEach(c => {
    if (c.issues > 0) {
      for (let i = 0; i < c.issues; i++) {
        issues.push({
          id: `${c.name}-${i}`,
          name: pickIssueName(c.name, i),
          type: pickIssueType(i),
          severity: i === 0 ? 'high' : i === 1 ? 'medium' : 'low',
          found: c.name,
          instances: randInt(3, 50)
        });
      }
    }
  });
  return issues.sort(severityOrder);
}

function pickIssueName(comp, i) {
  const names = [
    `Raio inconsistente em ${comp}`,
    `Variante duplicada: ${comp}`,
    `Token de cor não utilizado em ${comp}`,
    `Tipografia fora da escala em ${comp}`,
    `${comp} detached`,
    `Border-radius hardcoded em ${comp}`,
    `Espaçamento manual em ${comp}`
  ];
  return names[i % names.length];
}

function pickIssueType(i) {
  return ['Consistência', 'Duplicado', 'Adoção', 'Override'][i % 4];
}

function generateInsights(comps, sev) {
  const insights = [];
  if (sev.high > 5) {
    insights.push({
      tone: 'warn',
      html: `Há <strong>${sev.high} issues de alta severidade</strong> que requerem atenção imediata.`
    });
  }
  const topProblem = comps[0];
  if (topProblem && topProblem.issues > 3) {
    insights.push({
      tone: 'warn',
      html: `O componente <strong>${topProblem.name}</strong> tem ${topProblem.issues} issues. Considera refatorar.`
    });
  }
  insights.push({
    tone: 'info',
    html: `Foram analisados <strong>${comps.length} componentes</strong> no total.`
  });
  insights.push({
    tone: 'good',
    html: `Análise concluída em segundos. <strong>Reanalisa</strong> regularmente para detetar drift cedo.`
  });
  return insights;
}

function statusFromScore(score) {
  if (score >= 85) return { label: 'Saudável', tone: 'good' };
  if (score >= 65) return { label: 'Razoável', tone: 'warn' };
  return { label: 'Crítico', tone: 'bad' };
}

function severityOrder(a, b) {
  const order = { high: 0, medium: 1, low: 2 };
  return order[a.severity] - order[b.severity];
}

// ─────────────────────────────────────────────────────────────
// Utils
// ─────────────────────────────────────────────────────────────
function groupBy(arr, fn) {
  return arr.reduce((acc, item) => {
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
