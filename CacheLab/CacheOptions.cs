using System.ComponentModel.DataAnnotations;

namespace CacheLab;

public class CacheOptions
{
    public const string SectionName = "Cache";

    // Base time-to-live for cached entries
    [Range(1, 86_400)]
    public int TtlSeconds { get; set; } = 30;

    // Random extra TTL added on top of the base (0.5 = up to +50%), so keys written together don't expire together
    [Range(0, 1)]
    public double JitterRatio { get; set; } = 0.5;
}
