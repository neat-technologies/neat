from django.db import models


class Order(models.Model):
    class Meta:
        db_table = "custom_orders"


class Customer(models.Model):
    name = models.CharField(max_length=100)


class LineItem(models.Model):
    class Meta:
        app_label = "billing"
