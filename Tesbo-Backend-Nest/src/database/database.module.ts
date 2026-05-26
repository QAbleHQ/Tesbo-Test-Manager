import { Global, Module, OnApplicationShutdown } from "@nestjs/common";
import { Pool } from "pg";
import { AppConfigService } from "../config/app-config.service";
import { DatabaseService } from "./database.service";
import { PG_POOL } from "./database.tokens";

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) =>
        new Pool({
          connectionString: config.databaseUrl,
          user: config.databaseUser || undefined,
          password: config.databasePassword || undefined,
          max: 10
        })
    },
    DatabaseService
  ],
  exports: [PG_POOL, DatabaseService]
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(private readonly database: DatabaseService) {}

  async onApplicationShutdown() {
    await this.database.close();
  }
}
