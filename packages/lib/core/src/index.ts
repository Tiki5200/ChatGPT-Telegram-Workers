import { runProactiveMessageCheck } from './companion/proactive';
import { ENV } from './config';
import { createRouter } from './route';

export * from './agent';
export * from './config';
export * from './i18n';
export * from './route';
export * from './telegram';

export const Workers = {
  async fetch(
    request: Request,
    env: any,
  ): Promise<Response> {
    try {
      ENV.merge(env);
      return createRouter().fetch(request);
    } catch (error) {
      console.error(error);

      return new Response(
        JSON.stringify({
          message: (error as Error).message,
          stack: (error as Error).stack,
        }),
        { status: 500 },
      );
    }
  },

  async scheduled(
    _controller: any,
    env: any,
    ctx: any,
  ): Promise<void> {
    ENV.merge(env);

    ctx.waitUntil(
      runProactiveMessageCheck(),
    );
  },
};