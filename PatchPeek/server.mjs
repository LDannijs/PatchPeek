import express from "express";
import path from "path";
import routes from "./routes/index.js";
import { updateAllFeeds } from "./services/update.js";

const app = express();
const port = 3000;

app.set("view engine", "ejs");
app.set("views", path.resolve("./views"));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.resolve("./public")));
app.use("/", routes);

(async () => {
  await updateAllFeeds();
  setInterval(updateAllFeeds, 60 * 60 * 1000);
  app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}\n`);
  });
})();
