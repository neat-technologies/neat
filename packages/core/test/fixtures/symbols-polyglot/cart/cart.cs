// Cart service — C# symbol-grain extraction fixture (#1025).

namespace Cart.Services
{
    public class CartService
    {
        private readonly ICartRepo _repo;

        public CartService(ICartRepo repo)
        {
            _repo = repo;
        }

        public Cart AddItem(string userId, Item item)
        {
            // An observed DB span's code.lineno points inside this method.
            return _repo.Save(userId, item);
        }

        public static decimal DefaultRate()
        {
            return 1.0m;
        }
    }

    public interface ICartRepo
    {
        Cart Save(string userId, Item item);
    }

    public struct Money
    {
        public decimal Amount;
    }

    public record Item(string Id, int Qty);
}
