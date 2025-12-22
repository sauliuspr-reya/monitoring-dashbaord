import type { AppProps } from 'next/app';
import type { Session } from 'next-auth';
import { SessionProvider } from 'next-auth/react';
import '../app/globals.css';

type AppPropsWithSession = AppProps<{
  session: Session | null;
}>;

export default function App({ Component, pageProps }: AppPropsWithSession) {
  const { session, ...restPageProps } = pageProps;

  return (
    <SessionProvider session={session}>
      <Component {...restPageProps} />
    </SessionProvider>
  );
}

