package plugin

import (
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestOAuthBroker(t *testing.T) {
	t.Run("delivers the result only to the matching user's subscribers", func(t *testing.T) {
		var events []OAuthCompleteEvent
		broker := NewOAuthBroker(func(event OAuthCompleteEvent) { events = append(events, event) })

		userCh := broker.SubscribeOAuthComplete("user1")
		otherCh := broker.SubscribeOAuthComplete("user2")
		connectErr := errors.New("connect failed")

		broker.publishOAuthComplete("user1", connectErr, false)

		select {
		case err := <-userCh:
			assert.Equal(t, connectErr, err)
		default:
			require.Fail(t, "expected the subscriber to receive the result")
		}
		assert.Empty(t, otherCh)
		assert.Equal(t, []OAuthCompleteEvent{{UserID: "user1", Err: connectErr}}, events)
	})

	t.Run("does not rebroadcast events that came from the cluster", func(t *testing.T) {
		broadcasts := 0
		broker := NewOAuthBroker(func(OAuthCompleteEvent) { broadcasts++ })
		ch := broker.SubscribeOAuthComplete("user1")

		broker.publishOAuthComplete("user1", nil, true)

		assert.Len(t, ch, 1)
		assert.Zero(t, broadcasts)
	})

	t.Run("publishing does not block on a full subscriber", func(t *testing.T) {
		broker := NewOAuthBroker(func(OAuthCompleteEvent) {})
		ch := broker.SubscribeOAuthComplete("user1")

		broker.publishOAuthComplete("user1", nil, true)
		done := make(chan struct{})
		go func() {
			broker.publishOAuthComplete("user1", nil, true)
			close(done)
		}()

		select {
		case <-done:
		case <-time.After(time.Second):
			require.Fail(t, "publishing blocked on a full subscriber")
		}
		assert.Len(t, ch, 1)
	})

	t.Run("unsubscribed channels no longer receive results", func(t *testing.T) {
		broker := NewOAuthBroker(func(OAuthCompleteEvent) {})
		removed := broker.SubscribeOAuthComplete("user1")
		kept := broker.SubscribeOAuthComplete("user1")

		broker.UnsubscribeOAuthComplete("user1", removed)
		broker.publishOAuthComplete("user1", nil, true)

		assert.Empty(t, removed)
		assert.Len(t, kept, 1)
	})

	t.Run("close closes subscribers and ignores later publishes", func(t *testing.T) {
		broadcasts := 0
		broker := NewOAuthBroker(func(OAuthCompleteEvent) { broadcasts++ })
		ch := broker.SubscribeOAuthComplete("user1")

		broker.Close()
		broker.Close()
		broker.publishOAuthComplete("user1", nil, false)

		_, open := <-ch
		assert.False(t, open)
		assert.Zero(t, broadcasts)
	})
}
