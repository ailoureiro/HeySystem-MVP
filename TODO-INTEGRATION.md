# Integração frontend ↔ API

Este documento explica como migrar do mock data para a Figma API real.

---

## Estado atual

O `index.html` tem uma função `generateMockData(figmaUrl)` que retorna dados fake. O backend (`netlify/functions/analyze.js`) já está pronto para devolver o **mesmo schema** mas com dados reais.

---

## O que mudar no `index.html`

### 1. Adicionar input para o token Figma

No modal "Nova análise", **abaixo do input do URL**, adiciona:

```html
<div class="field-group" style="margin-top: var(--space-4);">
  <label class="field-label" for="modal-figma-token">
    Token Figma
    <a href="https://www.figma.com/developers/api#access-tokens"
       target="_blank" rel="noopener"
       style="font-weight: 400; color: var(--color-text-tertiary); margin-left: 4px;">
      Como obter?
    </a>
  </label>
  <input
    type="password"
    id="modal-figma-token"
    class="field-input"
    placeholder="figd_..."
    autocomplete="off"
  />
</div>
```

Faz o mesmo na landing page (no formulário inicial).

### 2. Substituir `startAnalysis()`

Localiza a função `startAnalysis(figmaUrl)` no `<script>` e substitui o uso de `generateMockData()` por uma chamada à API:

```javascript
async function startAnalysis(figmaUrl, figmaToken) {
  showScreen('loading');
  startLoadingAnimation();

  try {
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ figmaUrl, figmaToken })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || `HTTP ${response.status}`);
    }

    const data = await response.json();
    state.data = data;
    state.view = 'overview';
    showScreen('dashboard');
    renderView('overview');
  } catch (err) {
    // Volta ao landing e mostra erro no input
    showScreen('landing');
    setError(err.message);
  }
}
```

### 3. Atualizar handlers de submit

Onde tens:

```javascript
startAnalysis(figmaUrl);
```

Passa o token também:

```javascript
const figmaToken = document.getElementById('modal-figma-token').value;
startAnalysis(figmaUrl, figmaToken);
```

Aplica em 2 sítios:
- Submit da landing (formulário inicial)
- Submit do modal (`submitModal()`)

### 4. Remover o mock (opcional)

Quando confirmares que a API real funciona, podes apagar `generateMockData()` e helpers relacionados (`generateAllIssues()`, `generateComponents()`) — passam a ser dead code.

---

## Testar localmente

```bash
# Terminal 1: corre o site + functions
netlify dev

# Terminal 2: testa a function diretamente
curl -X POST http://localhost:8888/api/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "figmaUrl": "https://www.figma.com/file/SEU_FILE_KEY/Nome",
    "figmaToken": "figd_SEU_TOKEN"
  }'
```

Deves receber JSON com `healthScore`, `components`, `tokens`, etc.

---

## Edge cases a tratar no frontend

| Erro | Como mostrar |
|---|---|
| Token inválido (403) | "Token Figma inválido. Verifica em figma.com/settings" |
| File não acessível (404) | "Ficheiro não encontrado ou sem permissão" |
| Rate limit (429) | "Demasiados pedidos. Tenta novamente em 1 minuto." |
| Timeout / network | "Não foi possível contactar a Figma. Verifica a tua ligação." |
| Resto (500) | "Algo correu mal. Tenta novamente." |

Map estes para mensagens claras em PT-PT em vez de mostrar o erro técnico.

---

## Validação do token no frontend (opcional)

Antes de enviar para a API, podes validar a forma do token:

```javascript
function validateFigmaToken(token) {
  // Personal Access Tokens da Figma começam com "figd_"
  if (!token || !token.startsWith('figd_')) {
    return { ok: false, error: 'Token deve começar com "figd_"' };
  }
  return { ok: true };
}
```

Não confirma que é válido (só a API o sabe), mas apanha typos óbvios.
