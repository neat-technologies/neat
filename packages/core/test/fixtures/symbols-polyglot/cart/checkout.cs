// Checkout — C# file-scoped-namespace + nested-type fixture (#1025).

namespace Cart.Checkout;

public class CheckoutService
{
    public int Total()
    {
        return 0;
    }

    public class Receipt
    {
        public string Render()
        {
            return "ok";
        }
    }
}
