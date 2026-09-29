using System.Diagnostics;
using CacheLab;
using StackExchange.Redis;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOptions<CacheOptions>()
    .BindConfiguration(CacheOptions.SectionName)
    .ValidateDataAnnotations()
    .ValidateOnStart();

// abortConnect=false in the connection string lets the API start even when Valkey is down;
// the client keeps reconnecting in the background
var valkeyOptions = ConfigurationOptions.Parse(builder.Configuration.GetConnectionString("Valkey")
    ?? throw new InvalidOperationException("Connection string 'Valkey' is missing"));
// While disconnected, fail commands immediately instead of queuing them until the connection is back.
// For a cache, a fast miss is better than a request stuck waiting (the default queues for several seconds).
valkeyOptions.BacklogPolicy = BacklogPolicy.FailFast;
builder.Services.AddSingleton<IConnectionMultiplexer>(ConnectionMultiplexer.Connect(valkeyOptions));
builder.Services.AddSingleton<ValkeyCache>();
builder.Services.AddSingleton<ProductRepository>();
builder.Services.AddSingleton<ProductService>();

var app = builder.Build();

// Dashboard (wwwroot) and the endpoints it uses to look inside Valkey. Development only,
// because they expose every key and can wipe the database.
if (app.Environment.IsDevelopment())
{
    app.UseDefaultFiles();
    app.UseStaticFiles();
    app.MapLabEndpoints();
}

// No cache: always hits the database (baseline for comparison)
app.MapGet("/products/{id:int}/no-cache", async (int id, ProductRepository repo) =>
{
    var sw = Stopwatch.StartNew();
    var product = await repo.GetByIdAsync(id);
    return product is null
        ? Results.NotFound()
        : Results.Ok(new { source = "database", ms = sw.ElapsedMilliseconds, product });
});

// Cache-aside: try the cache first; on a miss, load from the database and populate the cache (see ProductService)
app.MapGet("/products/{id:int}", async (int id, ProductService products) =>
{
    var result = await products.GetAsync(id);
    return result.Product is null
        ? Results.NotFound()
        : Results.Ok(new { source = result.Source, ms = result.Ms, product = result.Product });
});

// Loads every product into the cache at once, simulating a warm-up after a deploy/restart.
// Without jitter all keys share the same TTL and expire together (cache avalanche).
app.MapPost("/cache/warm", async (ValkeyCache cache, ProductRepository repo, bool jitter = false) =>
{
    var products = await repo.GetAllAsync();
    var warmed = await cache.SetManyAsync(products.Select(p => KeyValuePair.Create(ProductService.Key(p.Id), p)), jitter);
    return warmed
        ? Results.Ok(new { warmed = products.Count, jitter })
        : Results.Problem("Cache is unavailable", statusCode: StatusCodes.Status503ServiceUnavailable);
});

app.MapGet("/stats", (ValkeyCache cache, ProductRepository repo) =>
    new { databaseQueries = repo.Queries, cache = cache.GetStats() });

app.MapPost("/stats/reset", (ValkeyCache cache, ProductRepository repo) =>
{
    cache.ResetStats();
    repo.ResetStats();
    return Results.NoContent();
});

// A cache outage degrades the API but doesn't break it, so it still answers 200 ("degraded").
// Returning 503 here would make a load balancer pull healthy instances out of rotation.
app.MapGet("/health", async (ValkeyCache cache) =>
{
    var ping = await cache.PingAsync();
    return ping is null
        ? Results.Ok(new { status = "degraded", cache = "unavailable" })
        : Results.Ok(new { status = "healthy", cache = "available", pingMs = Math.Round(ping.Value.TotalMilliseconds, 2) });
});

app.Run();
