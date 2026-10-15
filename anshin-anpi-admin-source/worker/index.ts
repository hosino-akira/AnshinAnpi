/** Cloudflare Worker の実行入口。 */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { proxyAdmin } from "../build/admin-proxy.mjs";

interface Env {
  ANSHIN_BACKEND_URL?: string;
  ASSETS: Fetcher;
  DB: D1Database;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// 拡張子 .svg の画像は最適化処理を経由せず、そのまま配信します。
// セキュリティヘッダー付きの最適化処理を経由させる場合は、
// next.config.ts に dangerouslyAllowSVG: true を設定して画像設定へ反映します。
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/admin/')) {
      if (!env.ANSHIN_BACKEND_URL) return Response.json({ error: { code: 'ADMIN_BACKEND_UNAVAILABLE', message: '管理 API の接続先が未設定です。' } }, { status: 503 });
      return (await proxyAdmin(request, env.ANSHIN_BACKEND_URL))!;
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
