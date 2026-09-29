using System.Diagnostics;
using StackExchange.Redis;

namespace CacheLab;

/// <summary>
/// Endpoints used by the dashboard (wwwroot) to look inside Valkey and to generate load.
/// Development only: they expose every key and can wipe the database.
/// </summary>
public static class LabEndpoints
{
    private const int MaxListItems = 50;

    public static void MapLabEndpoints(this WebApplication app)
    {
        var valkey = app.MapGroup("/valkey");

        // Unlike the product endpoints, these talk to Valkey directly, so an outage surfaces as 503
        valkey.AddEndpointFilter(async (context, next) =>
        {
            try
            {
                return await next(context);
            }
            catch (Exception ex) when (ex is RedisException or RedisTimeoutException)
            {
                return Results.Problem(ex.Message, statusCode: StatusCodes.Status503ServiceUnavailable);
            }
        });

        // Selected fields from INFO plus DBSIZE
        valkey.MapGet("/info", async (IConnectionMultiplexer mux) =>
        {
            var server = Server(mux);
            var info = new Dictionary<string, string>();
            foreach (var section in await server.InfoAsync())
                foreach (var (key, value) in section)
                    info[key] = value;

            return Results.Ok(new
            {
                version = info.GetValueOrDefault("valkey_version") ?? info.GetValueOrDefault("redis_version"),
                uptimeSeconds = Number(info, "uptime_in_seconds"),
                connectedClients = Number(info, "connected_clients"),
                usedMemoryBytes = Number(info, "used_memory"),
                maxMemoryBytes = Number(info, "maxmemory"),
                maxMemoryPolicy = info.GetValueOrDefault("maxmemory_policy"),
                opsPerSecond = Number(info, "instantaneous_ops_per_sec"),
                totalCommands = Number(info, "total_commands_processed"),
                keyspaceHits = Number(info, "keyspace_hits"),
                keyspaceMisses = Number(info, "keyspace_misses"),
                expiredKeys = Number(info, "expired_keys"),
                evictedKeys = Number(info, "evicted_keys"),
                keys = await server.DatabaseSizeAsync(),
            });
        });

        // Keys matching a pattern, with their remaining TTL (-1 = no expiry)
        valkey.MapGet("/keys", async (IConnectionMultiplexer mux, string pattern = "*", int limit = 500) =>
        {
            limit = Math.Clamp(limit, 1, 2000);
            var db = mux.GetDatabase();

            // KeysAsync uses SCAN under the hood: it walks the keyspace in small batches instead of blocking the server like KEYS
            var keys = new List<RedisKey>();
            await foreach (var key in Server(mux).KeysAsync(pattern: pattern, pageSize: 250))
            {
                keys.Add(key);
                if (keys.Count > limit)
                    break;
            }

            var truncated = keys.Count > limit;
            if (truncated)
                keys.RemoveAt(keys.Count - 1);

            // One PTTL per key, all sent at once over the same connection (pipelining)
            var ttls = await Task.WhenAll(keys.Select(k => db.KeyTimeToLiveAsync(k)));

            return Results.Ok(new
            {
                truncated,
                keys = keys.Select((k, i) => new { key = k.ToString(), ttlMs = TtlMs(ttls[i]) }),
            });
        });

        // Type, TTL and value of a single key, read with the command that matches its type
        valkey.MapGet("/key", async (IConnectionMultiplexer mux, string key) =>
        {
            var db = mux.GetDatabase();
            var type = await db.KeyTypeAsync(key);
            if (type == RedisType.None)
                return Results.NotFound();

            const int last = MaxListItems - 1;
            var (command, value) = type switch
            {
                RedisType.String => ($"GET {key}", (object?)(string?)await db.StringGetAsync(key)),
                RedisType.Hash => ($"HGETALL {key}", (await db.HashGetAllAsync(key))
                    .ToDictionary(e => e.Name.ToString(), e => e.Value.ToString())),
                RedisType.List => ($"LRANGE {key} 0 {last}", (await db.ListRangeAsync(key, 0, last))
                    .Select(v => v.ToString()).ToArray()),
                RedisType.Set => ($"SMEMBERS {key}", (await db.SetMembersAsync(key))
                    .Take(MaxListItems).Select(v => v.ToString()).ToArray()),
                RedisType.SortedSet => ($"ZRANGE {key} 0 {last} WITHSCORES", (await db.SortedSetRangeByRankWithScoresAsync(key, 0, last))
                    .Select(e => new { member = e.Element.ToString(), score = e.Score }).ToArray()),
                _ => ($"TYPE {key}", null),
            };

            return Results.Ok(new
            {
                key,
                type = type.ToString().ToLowerInvariant(),
                ttlMs = TtlMs(await db.KeyTimeToLiveAsync(key)),
                command,
                value,
            });
        });

        valkey.MapDelete("/key", async (IConnectionMultiplexer mux, string key) =>
            Results.Ok(new { deleted = await mux.GetDatabase().KeyDeleteAsync(key) }));

        // FLUSHDB is an admin command: it needs allowAdmin=true (set in appsettings.Development.json)
        valkey.MapPost("/flush", async (IConnectionMultiplexer mux) =>
        {
            await Server(mux).FlushDatabaseAsync();
            return Results.NoContent();
        });

        // Fires N lookups at the same instant (in-process, through the same cache-aside code as GET /products/{id}).
        // On an empty cache, concurrent misses for the same key all reach the database: a cache stampede.
        app.MapPost("/lab/burst", async (ProductService products, ProductRepository repo, int requests = 200, int distinctIds = 5) =>
        {
            requests = Math.Clamp(requests, 1, 2000);
            distinctIds = Math.Clamp(distinctIds, 1, 100);

            var queriesBefore = repo.Queries;
            var sw = Stopwatch.StartNew();
            var results = await Task.WhenAll(Enumerable.Range(0, requests)
                .Select(i => products.GetAsync(i % distinctIds + 1)));
            var latencies = results.Select(r => r.Ms).Order().ToArray();

            return new
            {
                requests,
                distinctIds,
                fromCache = results.Count(r => r.Source == ProductService.FromCache),
                fromDatabase = results.Count(r => r.Source == ProductService.FromDatabase),
                databaseQueries = repo.Queries - queriesBefore,
                elapsedMs = sw.ElapsedMilliseconds,
                p50Ms = Percentile(latencies, 0.50),
                p95Ms = Percentile(latencies, 0.95),
                maxMs = latencies[^1],
            };
        });
    }

    private static IServer Server(IConnectionMultiplexer mux) => mux.GetServer(mux.GetEndPoints()[0]);

    private static long Number(Dictionary<string, string> info, string key) =>
        long.TryParse(info.GetValueOrDefault(key), out var value) ? value : 0;

    private static long TtlMs(TimeSpan? ttl) => ttl is { } t ? (long)t.TotalMilliseconds : -1;

    private static long Percentile(long[] sorted, double p) =>
        sorted[Math.Max(0, (int)Math.Ceiling(p * sorted.Length) - 1)];
}
