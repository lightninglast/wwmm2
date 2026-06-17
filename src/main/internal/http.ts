import ky from "ky";
import { Agent, Pool } from "undici";
import { appVersion } from "../const";
import type { WWMM2App } from "../index";

interface FetcherOptions extends RequestInit {}

export class DesktopHttpService {
    private cachedAgent: Agent | null = null;

    constructor(private readonly desktop: WWMM2App) {}

    public async getAgent() {
        if (this.cachedAgent) {
            return this.cachedAgent;
        }

        this.cachedAgent = new Agent({
            factory(origin, options) {
                return new Pool(origin, {
                    ...options,
                    allowH2: true,
                });
            },
        });

        return this.cachedAgent;
    }

    public async getHeaders(_url: string) {
        return {
            "User-Agent": `WWMM2/${appVersion}`,
        };
    }

    public async fetcher(url: string, options?: FetcherOptions) {
        const resp = await ky(url, {
            ...options,
            headers: {
                ...options?.headers,
                ...(await this.getHeaders(url)),
            },
            timeout: 100000,
            retry: {
                limit: 2,
            },
            // @ts-expect-error - dispatcher is not in the type definition, but it's passed through to fetch.
            dispatcher: await this.getAgent(),
            hooks: {
                afterResponse: [
                    ({ response }) => {
                        if (response.status === 524) {
                            return new Response("cloudflare timeout. but it's ok", { status: 200 });
                        } else {
                            return response;
                        }
                    },
                ],
                beforeError: [
                    // @ts-expect-error
                    async ({ response, error }) => {
                        if (response && response.status === 524) {
                            return error;
                        }
                        return error;
                    },
                ],
            },
        });

        return resp;
    }
}
