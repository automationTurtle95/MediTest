using MediTest.Services;
using Xunit;

namespace MediTest.Tests;

public sealed class RestrictedAccessPolicyTests
{
    [Theory]
    [InlineData("GET", "/api/tests")]
    [InlineData("GET", "/api/tests/sources")]
    [InlineData("GET", "/api/tests/42/resume")]
    [InlineData("GET", "/api/tests/42/review")]
    [InlineData("POST", "/api/tests/start")]
    [InlineData("PUT", "/api/tests/42/draft")]
    [InlineData("POST", "/api/tests/42/submit")]
    [InlineData("GET", "/api/settings")]
    public void TestExecutionAndRequiredSettingsRemainAvailable(string method, string path)
    {
        Assert.True(RestrictedAccessPolicy.Allows(method, path));
    }

    [Theory]
    [InlineData("POST", "/api/documents/upload")]
    [InlineData("POST", "/api/documents/import-txt")]
    [InlineData("POST", "/api/documents/12/generate-questions")]
    [InlineData("POST", "/api/questions/manual")]
    [InlineData("PUT", "/api/questions/42")]
    [InlineData("GET", "/api/documents")]
    [InlineData("GET", "/api/documents/12/questions")]
    [InlineData("GET", "/api/questions/by-topic")]
    [InlineData("GET", "/api/catalog/tests")]
    [InlineData("GET", "/api/catalog/tests/test-1/questions")]
    [InlineData("PUT", "/api/catalog/tests/test-1/questions/0")]
    [InlineData("POST", "/api/catalog/tests/test-1/download")]
    [InlineData("POST", "/api/catalog/tests/test-1/checkout")]
    [InlineData("GET", "/api/stats/overview")]
    [InlineData("GET", "/api/tests/42/pdf")]
    [InlineData("PUT", "/api/tests/42/name")]
    [InlineData("DELETE", "/api/tests/42")]
    [InlineData("DELETE", "/api/tests")]
    [InlineData("POST", "/api/stats/overview")]
    [InlineData("GET", "/api/ai/status")]
    [InlineData("PUT", "/api/settings")]
    public void NonTestFeaturesRequireFullAccess(string method, string path)
    {
        Assert.False(RestrictedAccessPolicy.Allows(method, path));
    }
}
