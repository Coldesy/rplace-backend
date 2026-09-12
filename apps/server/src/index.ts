import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const { server } = await createApp(config);

server.listen(config.port, () => {
  console.log(`canvas prototype listening on http://localhost:${config.port}${config.wsPath}`);
});
