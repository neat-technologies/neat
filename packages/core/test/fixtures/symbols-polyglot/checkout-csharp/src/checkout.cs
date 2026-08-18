namespace Checkout.Services;

// Nested-layout .NET service: the project and its source live in a `src/`
// subdirectory of the service root, the shape the otel-demo `cart` service uses.
public class CheckoutService
{
    private readonly int _rate;

    public CheckoutService(int rate)
    {
        _rate = rate;
    }

    public int Total(int subtotal, int quantity)
    {
        return subtotal * quantity + _rate;
    }
}
