import { Pos } from './pos';

const MINT_URL = process.env.NEXT_PUBLIC_MINT_URL ?? 'https://mint.minibits.cash/Bitcoin';

export default function Page() {
  return <Pos mintUrl={MINT_URL} />;
}
