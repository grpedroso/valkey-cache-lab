using System.Text.Json;
using Microsoft.Extensions.Options;
using StackExchange.Redis;

namespace CacheLab;

public record CacheStats(long Hits, long Misses, long Errors, double HitRatio);

/// <summary>
/// Thin wrapper over Valkey for the cache-aside pattern.
/// The cache is an optimization, not the source of truth: every cache failure is logged
/// and treated as a miss, so an unavailable cache makes the API slower but never breaks it.
/// </summary>
public class ValkeyCache(IConnectionMultiplexer valkey, IOptions<CacheOptions> options, ILogger<ValkeyCache> logger)
{
    private readonly CacheOptions _options = options.Value;
    private long _hits, _misses, _errors;

    public async Task<T?> GetAsync<T>(string key) where T : class
    {
        try
        {
            var value = await valkey.GetDatabase().StringGetAsync(key);
            if (value.HasValue)
            {
                var result = JsonSerializer.Deserialize<T>(value.ToString());
                Interlocked.Increment(ref _hits);
                return result;
            }
        }
        catch (Exception ex) when (IsCacheFailure(ex))
        {
            Interlocked.Increment(ref _errors);
            logger.LogWarning(ex, "Cache read failed for {Key}; treating it as a miss", key);
        }

        Interlocked.Increment(ref _misses);
        return null;
    }

    // Best effort: failing to write to the cache must not fail the request
    public async Task SetAsync<T>(string key, T value, bool jitter = true)
    {
        try
        {
            await valkey.GetDatabase().StringSetAsync(key, JsonSerializer.Serialize(value), Ttl(jitter));
        }
        catch (Exception ex) when (IsCacheFailure(ex))
        {
            Interlocked.Increment(ref _errors);
            logger.LogWarning(ex, "Cache write failed for {Key}", key);
        }
    }

    // Sends all writes without awaiting each one; the client pipelines them over the same connection
    public async Task<bool> SetManyAsync<T>(IEnumerable<KeyValuePair<string, T>> entries, bool jitter = true)
    {
        try
        {
            var db = valkey.GetDatabase();
            await Task.WhenAll(entries.Select(e =>
                db.StringSetAsync(e.Key, JsonSerializer.Serialize(e.Value), Ttl(jitter))));
            return true;
        }
        catch (Exception ex) when (IsCacheFailure(ex))
        {
            Interlocked.Increment(ref _errors);
            logger.LogWarning(ex, "Cache bulk write failed");
            return false;
        }
    }

    public async Task<TimeSpan?> PingAsync()
    {
        try
        {
            return await valkey.GetDatabase().PingAsync();
        }
        catch (Exception ex) when (IsCacheFailure(ex))
        {
            return null;
        }
    }

    public CacheStats GetStats()
    {
        var hits = Interlocked.Read(ref _hits);
        var misses = Interlocked.Read(ref _misses);
        var total = hits + misses;
        return new CacheStats(hits, misses, Interlocked.Read(ref _errors), total == 0 ? 0 : Math.Round((double)hits / total, 3));
    }

    public void ResetStats()
    {
        Interlocked.Exchange(ref _hits, 0);
        Interlocked.Exchange(ref _misses, 0);
        Interlocked.Exchange(ref _errors, 0);
    }

    private TimeSpan Ttl(bool jitter)
    {
        double seconds = _options.TtlSeconds;
        if (jitter)
            seconds *= 1 + Random.Shared.NextDouble() * _options.JitterRatio;
        return TimeSpan.FromSeconds(seconds);
    }

    // RedisTimeoutException inherits from TimeoutException, not RedisException, so both are listed.
    // JsonException covers entries that can't be deserialized (e.g. written by something else).
    private static bool IsCacheFailure(Exception ex) =>
        ex is RedisException or RedisTimeoutException or JsonException;
}
