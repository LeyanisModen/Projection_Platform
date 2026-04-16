# Setup completo de herramientas AI - INAK

Guia para configurar MCPs, skills y plugins en todos los clientes de IA (Claude Code, Codex, Antigravity/Gemini).

**Requisitos previos:**
- Node.js + npm instalados
- Antigravity IDE instalado
- Extension Claude Code instalada en Antigravity
- Codex CLI instalado (`npm i -g @openai/codex`)
- Claude Code CLI instalado (`npm i -g @anthropic-ai/claude-code`)

---

## 1. MCPs (Model Context Protocol Servers)

Los MCPs dan herramientas extra a la IA: navegar webs, buscar documentacion, memoria persistente, etc.

### 1.1 Claude Code (CLI + extension)

Ejecutar estos comandos en terminal:

```bash
claude mcp add -s user playwright -- cmd /c npx -y @playwright/mcp
claude mcp add -s user memory -- cmd /c npx -y @modelcontextprotocol/server-memory
claude mcp add -s user context7 -- cmd /c npx -y @upstash/context7-mcp@latest
claude mcp add -s user exa --env EXA_API_KEY=TU_API_KEY_DE_EXA -- cmd /c npx -y exa-mcp-server
```

Para el MCP de GitHub, editar manualmente `~/.claude/settings.json` y anadir dentro de `"mcpServers"`:

```json
"github": {
  "type": "url",
  "url": "https://api.githubcopilot.com/mcp/"
}
```

> **Nota Exa:** Necesitas una API key de https://exa.ai (tienen plan gratuito). Sustituye `TU_API_KEY_DE_EXA` por tu key.

### 1.2 Codex CLI

Editar el fichero `~/.codex/config.toml` (crearlo si no existe) y anadir al final:

```toml
# --- MCP Servers ---

[mcp_servers.playwright]
command = "cmd"
args = ["/c", "npx", "-y", "@playwright/mcp"]

[mcp_servers.memory]
command = "cmd"
args = ["/c", "npx", "-y", "@modelcontextprotocol/server-memory"]

[mcp_servers.exa]
command = "cmd"
args = ["/c", "npx", "-y", "exa-mcp-server"]

[mcp_servers.exa.env]
EXA_API_KEY = "TU_API_KEY_DE_EXA"

[mcp_servers.context7]
command = "cmd"
args = ["/c", "npx", "-y", "@upstash/context7-mcp@latest"]

[mcp_servers.github]
type = "url"
url = "https://api.githubcopilot.com/mcp/"
```

### 1.3 Antigravity / Gemini

Editar el fichero `~/.gemini/antigravity/mcp_config.json` (crearlo si no existe):

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp"]
    },
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"]
    },
    "exa": {
      "command": "npx",
      "args": ["-y", "exa-mcp-server"],
      "env": {
        "EXA_API_KEY": "TU_API_KEY_DE_EXA"
      }
    },
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp@latest"]
    },
    "github": {
      "serverUrl": "https://api.githubcopilot.com/mcp/"
    }
  }
}
```

### Que hace cada MCP

| MCP | Descripcion |
|-----|-------------|
| **Playwright** | Automatiza navegador: screenshots, clicks, formularios, depurar UI en vivo |
| **Memory** | Memoria persistente entre conversaciones (knowledge graph) |
| **Context7** | Documentacion actualizada de cualquier libreria/framework |
| **Exa** | Busqueda web avanzada optimizada para IA |
| **GitHub** | Acceso a PRs, issues, repos desde la IA |

---

## 2. Plugins (solo Claude Code)

Los plugins son extensiones cloud exclusivas de Claude Code. Ejecutar:

```bash
claude plugins enable context7@claude-plugins-official
claude plugins enable claude-mem@thedotmack
```

O editar `~/.claude/settings.json` y anadir:

```json
"enabledPlugins": {
  "context7@claude-plugins-official": true,
  "claude-mem@thedotmack": true
}
```

| Plugin | Descripcion |
|--------|-------------|
| **context7** | Docs actualizadas de librerias (version cloud del MCP) |
| **claude-mem** | Memoria persistente con busqueda inteligente y AST parsing |

---

## 3. Skills (para todos los clientes)

Las skills son instrucciones reutilizables que cualquier agente de IA puede usar. Se instalan globalmente con `npx skills`.

### 3.1 Repos de skills

Ejecutar estos 2 comandos en terminal:

```bash
npx skills add https://github.com/vercel-labs/skills --skill find-skills --yes --global
npx skills add https://github.com/thedotmack/claude-mem --yes --global
```

Esto instala 5 skills globales:

| Skill | Descripcion |
|-------|-------------|
| **find-skills** | Descubre e instala nuevas skills |
| **do** | Ejecuta planes de implementacion con subagentes |
| **make-plan** | Crea planes detallados de implementacion |
| **mem-search** | Busca en memoria persistente entre sesiones |
| **smart-explore** | Exploracion de codigo optimizada con tree-sitter |

### 3.2 Verificar instalacion

```bash
npx skills list
```

Deberian aparecer las skills con los agentes asociados (Antigravity, Claude Code, Codex, Cursor, Gemini CLI, etc.).

---

## 4. Verificacion rapida

### Claude Code
```bash
claude mcp list
```
Debe mostrar: playwright, memory, exa, context7, github

### Codex
Abrir Codex en cualquier proyecto. Al arrancar deberia detectar los MCP servers.

### Antigravity
Abrir panel Gemini Agent > MCP Servers. Deben aparecer los 5 servidores.

---

## Resumen

| Componente | Claude Code | Codex | Antigravity/Gemini |
|------------|:-----------:|:-----:|:------------------:|
| Playwright | ✓ | ✓ | ✓ |
| Memory | ✓ | ✓ | ✓ |
| Context7 | ✓ | ✓ | ✓ |
| Exa | ✓ | ✓ | ✓ |
| GitHub | ✓ | ✓ | ✓ |
| Plugin context7 | ✓ | - | - |
| Plugin claude-mem | ✓ | - | - |
| Skills (5 globales) | ✓ | ✓ | ✓ |

> Los plugins solo existen en Claude Code. Los MCPs y skills funcionan en todos los clientes.
