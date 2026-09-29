using System.Collections.Concurrent;

namespace CacheLab;

public record Product(int Id, string Name, decimal Price);

/// <summary>
/// Fake "slow database": every query takes 500 ms and is counted, so the effect of the cache is visible.
/// </summary>
public class ProductRepository
{
    private static readonly TimeSpan Latency = TimeSpan.FromMilliseconds(500);

    private readonly ConcurrentDictionary<int, Product> _products = new(
        Enumerable.Range(1, 100)
            .ToDictionary(i => i, i => new Product(i, $"Product {i}", 10m * i)));

    private int _queries;
    public int Queries => _queries;

    public async Task<Product?> GetByIdAsync(int id)
    {
        Interlocked.Increment(ref _queries);
        await Task.Delay(Latency);
        return _products.GetValueOrDefault(id);
    }

    // One slow query that returns everything
    public async Task<IReadOnlyCollection<Product>> GetAllAsync()
    {
        Interlocked.Increment(ref _queries);
        await Task.Delay(Latency);
        return _products.Values.ToList();
    }

    public void ResetStats() => Interlocked.Exchange(ref _queries, 0);
}
