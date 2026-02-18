package com.bettercases;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import liquibase.Liquibase;
import liquibase.database.DatabaseFactory;
import liquibase.database.jvm.JdbcConnection;
import liquibase.resource.ClassLoaderResourceAccessor;

import javax.sql.DataSource;
import java.sql.Connection;

public final class Database {
    private static volatile HikariDataSource dataSource;

    public static DataSource getDataSource() {
        if (dataSource == null) {
            synchronized (Database.class) {
                if (dataSource == null) {
                    HikariConfig config = new HikariConfig();
                    config.setJdbcUrl(Config.DB_URL);
                    config.setUsername(Config.DB_USER);
                    config.setPassword(Config.DB_PASSWORD);
                    config.setMaximumPoolSize(10);
                    dataSource = new HikariDataSource(config);
                    runMigrations();
                }
            }
        }
        return dataSource;
    }

    private static void runMigrations() {
        try (Connection c = dataSource.getConnection()) {
            Liquibase liquibase = new Liquibase(
                    "db/changelog/db.changelog-master.xml",
                    new ClassLoaderResourceAccessor(Thread.currentThread().getContextClassLoader()),
                    DatabaseFactory.getInstance().findCorrectDatabaseImplementation(new JdbcConnection(c))
            );
            liquibase.update();
        } catch (Exception e) {
            throw new RuntimeException("Liquibase migration failed", e);
        }
    }

    public static void close() {
        if (dataSource != null && !dataSource.isClosed()) {
            dataSource.close();
        }
    }

    private Database() {}
}
