package main

import (
	"context"

	"github.com/IBM/sarama"
)

func consume(ctx context.Context, group sarama.ConsumerGroup, handler sarama.ConsumerGroupHandler) error {
	// consumer group subscribes to the orders topic
	return group.Consume(ctx, []string{"orders"}, handler)
}
