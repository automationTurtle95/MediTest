using MediTest.Services;
using Xunit;

namespace MediTest.Tests;

public sealed class RestrictedAccessPolicyTests
{
    [Theory]
    [InlineData("GET", "/api/documents")]
    [InlineData("GET", "/api/documents/12/questions")]
    [InlineData("POST", "/api/tests/start")]
    [InlineData("PUT", "/api/tests/42/draft")]
    [InlineData("GET", "/api/stats/overview")]
    [InlineData("POST", "/api/catalog/tests/test-1/checkout")]
    public void ExistingLearningAndCatalogRoutesRemainAvailable(string method, string path)
    {
        Assert.True(RestrictedAccessPolicy.Allows(method, path));
    }

    [Theory]
    [InlineData("POST", "/api/documents/upload")]
    [InlineData("POST", "/api/documents/import-txt")]
    [InlineData("POST", "/api/documents/12/generate-questions")]
    [InlineData("POST", "/api/questions/manual")]
    [InlineData("PUT", "/api/questions/42")]
    [InlineData("PUT", "/api/tests/42/name")]
    [InlineData("DELETE", "/api/tests/42")]
    [InlineData("DELETE", "/api/tests")]
    [InlineData("POST", "/api/stats/overview")]
    [InlineData("GET", "/api/ai/status")]
    [InlineData("PUT", "/api/settings")]
    public void ContentCreationAndAiRoutesRequireFullAccess(string method, string path)
    {
        Assert.False(RestrictedAccessPolicy.Allows(method, path));
    }
}
