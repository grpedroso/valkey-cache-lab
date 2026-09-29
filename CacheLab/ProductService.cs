using System.Diagnostics;

namespace CacheLab;

public record ProductLookup(Product? Product, string Source, long Ms);

/// <summary>
/// The cache-aside pattern, in one place, so the HTTP endpoint and the load test run the exact same code.
/// </summary>
public class ProductService(ValkeyCache cache, ProductRepository repo)
{
    public const string FromCache = "cache";
    public const string FromDatabase = "database";

    public async Task<ProductLookup> GetAsync(int id)
    {
        var sw = Stopwatch.StartNew();
        var key = Key(id);

        // 1. Try the cache (a cache failure behaves like a miss)
        var cached = await cache.GetAsync<Product>(key);
        if (cached is not null)
            return new ProductLookup(cached, FromCache, sw.ElapsedMilliseconds);

        // 2. Miss: load from the database
        var product = await repo.GetByIdAsync(id);
        if (product is null)
            return new ProductLookup(null, FromDatabase, sw.ElapsedMilliseconds);

        // 3. Store in the cache (TTL with jitter) and return
        await cache.SetAsync(key, product);
        return new ProductLookup(product, FromDatabase, sw.ElapsedMilliseconds);
    }

    public static string Key(int id) => $"product:{id}";
}
