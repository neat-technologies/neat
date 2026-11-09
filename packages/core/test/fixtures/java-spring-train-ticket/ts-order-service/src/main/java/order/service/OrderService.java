package order.service;

import edu.fudan.common.entity.Seat;
import edu.fudan.common.util.Response;
import order.entity.Order;
import order.entity.OrderAlterInfo;
import order.entity.OrderInfo;
import org.springframework.http.HttpHeaders;

import java.util.ArrayList;
import java.util.Date;

/**
 * @author fdse
 */
public interface OrderService {

    Response getSoldTickets(Seat seatRequest, HttpHeaders headers);

    Response create(Order order, HttpHeaders headers);

    Response addNewOrder(Order order, HttpHeaders headers);

    Response queryOrders(OrderInfo qi, String accountId, HttpHeaders headers);

    Response queryOrdersForRefresh(OrderInfo qi, String accountId, HttpHeaders headers);

    Response saveChanges(Order order, HttpHeaders headers);

    Response cancelOrder(String accountId, String orderId, HttpHeaders headers);

    Response queryAlreadySoldOrders(Date travelDate, String trainNumber, HttpHeaders headers);

    Response getAllOrders(HttpHeaders headers);

    Response modifyOrder(String orderId, int status, HttpHeaders headers);

    Response getOrderPrice(String orderId, HttpHeaders headers);

    Response payOrder(String orderId, HttpHeaders headers);

    Response getOrderById(String orderId, HttpHeaders headers);

    void initOrder(Order order, HttpHeaders headers);

    Response checkSecurityAboutOrder(Date dateFrom, String accountId, HttpHeaders headers);

    Response deleteOrder(String orderId, HttpHeaders headers);

    Response alterOrder(OrderAlterInfo oai, HttpHeaders headers);

    Response updateOrder(Order order, HttpHeaders headers);

    Response findOrderById(String id, HttpHeaders headers);
}
