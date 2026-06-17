import { serve } from "@hono/node-server";
import { appVersion } from "@main/const";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { desktop } from "..";

export const app = new Hono()
    .use(cors())
    .onError((err, ctx) => {
        desktop.logger.error(err, "HonoServer");
        return ctx.text("Internal Server Error", 500);
    })
    .get("/version", async (ctx) => {
        return ctx.text(appVersion);
    })
    .get("/ping", (ctx) => ctx.text("pong"));

export async function startServer() {
    serve({
        fetch: app.fetch,
        port: 1027,
    });
}
