require("dotenv").config();

const { createApp } = require("./app");
const { config } = require("./config");

const PORT = process.env.PORT || 3000;
const app = createApp();

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`${config.APP_NAME} avviato su http://localhost:${PORT}`);
  });
}

module.exports = { app };
