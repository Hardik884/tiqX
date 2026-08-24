export function ErrorBanner({ message }: { message: string }): JSX.Element {
  return <div className="banner banner-error">{message}</div>;
}

export function SuccessBanner({ message }: { message: string }): JSX.Element {
  return <div className="banner banner-success">{message}</div>;
}
