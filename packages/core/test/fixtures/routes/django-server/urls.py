from django.urls import path, include
from . import views

urlpatterns = [
    path("", views.home),
    path("orders/", views.list_orders),
    path("orders/<int:order_id>/", views.detail),
    path("api/", include("api.urls")),
]
