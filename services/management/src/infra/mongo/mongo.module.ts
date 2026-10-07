import { Global, Inject, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientSession, Collection, Db, Document, MongoClient, TransactionOptions } from 'mongodb';
import { Env } from '../../config/env.js';

export const MONGO_CLIENT = Symbol('MONGO_CLIENT');
export const MANAGEMENT_DB = Symbol('MANAGEMENT_DB');

/**
 * One MongoClient for the process, pointed at the service-owned `management_db`.
 * Timeouts are bounded so a slow Atlas never hangs a request or a health check.
 */
@Injectable()
export class MongoService implements OnModuleDestroy {
  constructor(
    @Inject(MONGO_CLIENT) readonly client: MongoClient,
    @Inject(MANAGEMENT_DB) readonly db: Db,
  ) {}

  collection<T extends Document>(name: string): Collection<T> {
    return this.db.collection<T>(name);
  }

  /**
   * Run fn inside one multi-document transaction. Used for every command that writes state + outbox:
   * either both land or neither does. Verified on the Atlas M0 cluster (see decisions D-03).
   */
  async withTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = this.client.startSession();
    const opts: TransactionOptions = { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 10_000 };
    try {
      let result!: T;
      await session.withTransaction(async () => {
        result = await fn(session);
      }, opts);
      return result;
    } finally {
      await session.endSession();
    }
  }

  /** Apply a $jsonSchema validator (collection validation, PDF §11). Creates the collection if needed. */
  async ensureValidator(name: string, schema: Document) {
    const exists = (await this.db.listCollections({ name }).toArray()).length > 0;
    if (!exists) await this.db.createCollection(name, { validator: { $jsonSchema: schema }, validationLevel: 'moderate' });
    else await this.db.command({ collMod: name, validator: { $jsonSchema: schema }, validationLevel: 'moderate' });
  }

  /** Readiness probe: a cheap round trip to the owned database. */
  async ping(): Promise<boolean> {
    try {
      await this.db.command({ ping: 1 });
      return true;
    } catch {
      return false;
    }
  }

  async onModuleDestroy() {
    await this.client.close();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: MONGO_CLIENT,
      inject: [ConfigService],
      useFactory: async (config: ConfigService<Env, true>) => {
        const timeout = config.get('MONGO_TIMEOUT_MS');
        const client = new MongoClient(config.get('MONGODB_URI'), {
          serverSelectionTimeoutMS: timeout,
          connectTimeoutMS: timeout,
          socketTimeoutMS: timeout * 4,
          maxPoolSize: 10, // Atlas Free allows 500 connections cluster-wide; keep the footprint small.
          appName: 'management-service',
        });
        await client.connect();
        return client;
      },
    },
    {
      provide: MANAGEMENT_DB,
      inject: [MONGO_CLIENT, ConfigService],
      useFactory: (client: MongoClient, config: ConfigService<Env, true>) => client.db(config.get('MANAGEMENT_DB_NAME')),
    },
    MongoService,
  ],
  exports: [MONGO_CLIENT, MANAGEMENT_DB, MongoService],
})
export class MongoModule {}
