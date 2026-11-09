namespace Accounting;

// A minimal flat-layout C# service standing in for the otel-demo `accounting`
// service: the directory is lowercase `accounting` (matching the deployed
// OTEL_SERVICE_NAME), while the project file is PascalCase `Accounting.csproj`.
public class OrderConsumer
{
    public void Consume(string orderId)
    {
        System.Console.WriteLine(orderId);
    }
}
