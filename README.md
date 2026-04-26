# anchor-browser-mcp

Cross-platform browser-history reader as an **MCP server**. Reads Chrome / Brave / Edge / Arc / Firefox / Safari sqlite history files directly. Mac / Windows / Linux.

Built as part of the [anchor](https://github.com/123oqwe/anchor-backend) personal-AI ecosystem, but works standalone with any MCP host.

## Tools

| Tool | Description |
|------|------|
| `browser_recent_visits` | Top URLs visited recently across all detected browsers |
| `browser_top_domains` | Aggregated domain visit counts |
| `browser_search` | Keyword search across URL + title (find a page user remembers) |
| `browser_status` | Platform + detected browser profiles + blocked-domain count |

## Install

```bash
npx -y @anchor/browser-mcp
```

Or globally:
```bash
npm i -g @anchor/browser-mcp
anchor-browser-mcp
```

## Use with anchor-backend

```bash
curl -X POST http://localhost:3001/api/mcp/servers -H "Content-Type: application/json" -d '{
  "name": "anchor-browser",
  "command": "npx",
  "args": ["-y", "@anchor/browser-mcp"]
}'
```

After connection, four tools auto-register as `mcp_anchor_browser_*`. Decision Agent + Custom Agents see them.

## Use with Claude Desktop

```json
{
  "mcpServers": {
    "anchor-browser": {
      "command": "npx",
      "args": ["-y", "@anchor/browser-mcp"]
    }
  }
}
```

## Browser support × Platform

|             | macOS | Windows | Linux |
|-------------|:-----:|:-------:|:-----:|
| Chrome      | ✅    | ✅      | ✅    |
| Brave       | ✅    | ✅      | ✅    |
| Edge        | ✅    | ✅      | ✅    |
| Arc         | ✅    | ✅      | —     |
| Firefox     | ✅    | ✅      | ✅    |
| Safari      | ✅    | —       | —     |

Reads multiple Chromium profiles (Default + Profile 1/2/3).

## Privacy

Sensitive domains blocked at source — never read or returned:
- Banking: chase / bankofamerica / wellsfargo / paypal / venmo / etc.
- Health: webmd / mayoclinic / mychart / etc.
- Auth: accounts.google / login.microsoftonline / auth0
- Password managers: 1password / lastpass / bitwarden
- Adult sites
- Anything containing "bank" or "health" in hostname

Read-only. Browser sqlite is copied to /tmp before reading (browsers lock the live file). No network calls. No telemetry.

## Note on browser locking

Browsers open the History sqlite with an exclusive lock while running. We copy the file to a temp location before reading, so the read works even while the browser is open. The copy is deleted immediately after.

## License

MIT
