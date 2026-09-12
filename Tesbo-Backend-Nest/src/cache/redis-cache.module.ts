import { Global, Inject, Logger, Module, OnApplicationShutdown } from "@nestjs/common";
import Redis from "ioredis";
import { AppConfigService } from "../config/app-config.service";
import { EntitlementCacheService } from "./entitlement-cache.service";
import { SessionCacheService } from "./session-cache.service";
import { REDIS_CACHE_CLIENT } from "./redis-cache.tokens";

const logger = new Logger("RedisCache");

/**
 * A second, dedicated ioredis connection against the same REDIS_URL BullMQ already uses — never
 * BullMQ's own connection objects, since mixing arbitrary GET/SET/DEL traffic onto a connection
 * BullMQ manages internally risks contending with its blocking-poll semantics.
 *
 * Tuned to fail fast rather than hang a request when Redis is slow or unreachable:
 * enableOfflineQueue is off (a command issued while disconnected rejects immediately instead of
 * queuing), maxRetriesPerRequest is 1, and commandTimeout bounds even a connected-but-slow command.
 * Every caller (SessionCacheService/EntitlementCacheService) wraps every call in try/catch and
 * treats a failure exactly like a cache miss — Redis being down must degrade this app to exactly
 * today's always-hit-Postgres behavior, never to a hang or a 500.
 */
export function buildRedisCacheClient(config: AppConfigService): Redis {
  const client = new Redis(config.redisUrl, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 3_000,
    commandTimeout: 500,
    retryStrategy: (times) => Math.min(times * 200, 5_000)
  });
  // Unhandled 'error' events crash the process in Node — same reason database.module.ts's pool
  // has its own listener. This cache is optional infrastructure; nothing here may ever take the
  // app down.
  client.on("error", (error) => {
    logger.warn(`redis cache connection error: ${error.message}`);
  });
  return client;
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CACHE_CLIENT,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => buildRedisCacheClient(config)
    },
    SessionCacheService,
    EntitlementCacheService
  ],
  exports: [SessionCacheService, EntitlementCacheService]
})
export class RedisCacheModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CACHE_CLIENT) private readonly client: Redis) {}

  async onApplicationShutdown() {
    // quit() is a graceful close (flushes in-flight commands); disconnect() would drop them. Wrapped
    // because a client already broken by a prior connection error can reject quit() itself, and a
    // shutdown-time cache-close failure must never stop the rest of the app from shutting down.
    await this.client.quit().catch(() => undefined);
  }
}
