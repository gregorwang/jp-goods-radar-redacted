import { EventManager } from "@/components/event-manager";

export default function EventsPage() {
  return (
    <main className="page-wrap events-page notifications-page">
      <EventManager fixedView="deliveries" />
    </main>
  );
}
