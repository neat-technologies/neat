package main

import (
	"context"
	"os"

	"github.com/IBM/sarama"
)

const paymentsTopic = "payments"

// A stray comment mentioning ProducerMessage{Topic: "ghost-topic"} must never
// mint a topic — index.ts masks comments before this recognizer runs.
func publish(ctx context.Context, producer sarama.SyncProducer) error {
	// literal topic — the otel-demo checkout -> orders publish
	msg := &sarama.ProducerMessage{
		Topic: "orders",
		Value: sarama.StringEncoder("order placed"),
	}
	if _, _, err := producer.SendMessage(msg); err != nil {
		return err
	}

	// const-resolved topic
	if _, _, err := producer.SendMessage(&sarama.ProducerMessage{Topic: paymentsTopic}); err != nil {
		return err
	}

	// env-only topic — NEAT can't see the value, so it stays unextracted
	envTopic := os.Getenv("KAFKA_EXTRA_TOPIC")
	producer.SendMessage(&sarama.ProducerMessage{Topic: envTopic})
	return nil
}
