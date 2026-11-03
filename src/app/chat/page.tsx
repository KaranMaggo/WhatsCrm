import { redirect } from 'next/navigation';

interface ChatPageProps {
  searchParams: Promise<{ conversation_id?: string; c?: string }>;
}

export default async function ChatPage({ searchParams }: ChatPageProps) {
  const params = await searchParams;
  const conversationId = params?.conversation_id || params?.c;
  if (conversationId) {
    redirect(`/inbox?c=${encodeURIComponent(conversationId)}`);
  }
  redirect('/inbox');
}
