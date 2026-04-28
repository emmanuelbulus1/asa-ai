/**
 * services/tasks.js
 *
 * FIX 3: Every order gets a UUID. simulateOrderFlow only pushes updates
 *         for the active orderId. If two orders fire simultaneously, they
 *         don't collide — each client only renders updates for their current order.
 *
 * FIX 5 (partial): Each update stores the current stage in session.memory
 *         so a reconnecting WebSocket can replay the last known stage immediately.
 */

export function simulateOrderFlow(userId, orderId, clients, session, onStageUpdate) {
  const stages = [
    { stage: "confirmed",  step: 1, total: 5, msg: "Restaurant confirmed your order" },
    { stage: "preparing",  step: 2, total: 5, msg: "Your food is being prepared fresh" },
    { stage: "picked_up",  step: 3, total: 5, msg: "Rider has picked up your order" },
    { stage: "near",       step: 4, total: 5, msg: "Rider is 5 minutes away" },
    { stage: "delivered",  step: 5, total: 5, msg: "Delivered! Enjoy your meal" }
  ];

  const delays = [2000, 5000, 9000, 14000, 19000];

  stages.forEach((update, i) => {
    setTimeout(() => {
      // Fix 3: Guard — only push if this orderId is still the active one
      if (session.memory.currentOrderId !== orderId) return;

      // Fix 5: Update session stage — reconnecting clients can replay this
      session.memory.currentOrderStage = update;
      if (onStageUpdate) onStageUpdate(userId);

      // Broadcast to all open connections for this user
      broadcast(userId, clients, {
        type: "order_update",
        orderId,
        ...update
      });

      // Clean up after delivery
      if (update.stage === "delivered") {
        session.memory.currentOrderId = null;
        session.memory.currentOrderStage = null;
        if (onStageUpdate) onStageUpdate(userId);
      }
    }, delays[i]);
  });
}

export function broadcast(userId, clients, payload) {
  const pool = clients.get(userId);
  if (!pool || pool.size === 0) return;
  const data = JSON.stringify(payload);
  for (const ws of pool) {
    if (ws.readyState === 1) ws.send(data);
  }
}
