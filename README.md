# miru-web

Local web UI for running multiple Pi agents in parallel.

## P0 features

- TypeScript end-to-end
- fixed local bind on `127.0.0.1:4242` by default
- one focused terminal at a time with `xterm.js`
- one `zellij` session per agent
- Pi launched inside each agent session
- existing `miru-agent-*` zellij sessions are rediscovered on server startup
- server shutdown detaches from agent sessions but does not kill them
- left agent list
- right `.miru` artifact pane per selected agent
- image upload to `.miru/pasted/`
- copy or insert uploaded full path into the terminal input
- dark condensed UI
- resizable and collapsible side panes

## Requirements

- Node.js
- `zellij` in `$PATH`
- `pi` in `$PATH`

## Install

```bash
npm install
npm run build
npm start
```

Open:

```text
http://127.0.0.1:4242
```

## Optional env vars

- `PORT` or `MIRU_WEB_PORT`
- `MIRU_WEB_CWD`
- `PI_COMMAND`

## Notes

- Agent state is kept in memory for P0.
- Pi keeps its own session persistence inside each terminal.
- Deleting an agent kills its managed `zellij` session.
