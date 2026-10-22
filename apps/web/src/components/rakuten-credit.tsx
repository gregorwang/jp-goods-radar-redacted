const officialCreditHtml = `<!-- Rakuten Web Services Attribution Snippet FROM HERE -->
<a href="https://webservice.rakuten.co.jp/" target="_blank"><img src="https://webservice.rakuten.co.jp/img/credit/200709/credit_22121.gif" border="0" alt="Rakuten Web Service Center" title="Rakuten Web Service Center" width="221" height="21"/></a>
<!-- Rakuten Web Services Attribution Snippet TO HERE -->`;

export function isRakutenSource(sourceId: string): boolean {
  return sourceId === "rakuten_ichiba" || sourceId === "rakuten_books";
}

export function RakutenCredit() {
  return <div className="rakuten-credit" aria-label="Rakuten Web Service attribution" data-testid="rakuten-credit"
    dangerouslySetInnerHTML={{ __html: officialCreditHtml }} />;
}
