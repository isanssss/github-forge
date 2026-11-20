// dev-server.ts — a local harness for the conformance suite: NOT imported by main.ts.
// Sets a development token when none is configured and listens on a fixed local port.

import { createApp } from './app.ts';

process.env.MAKEFUN_SHOP_TOKEN ??= 'dev-token';

const server = createApp();
server.listen(8791, () => {
  process.stdout.write('[dev] listening on port 8791\n');
});
