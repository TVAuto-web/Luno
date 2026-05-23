function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const json = (res, status, body) => res.status(status).json(body);

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function amount(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n.toFixed(2) : '0.00';
}

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function compactDate(value) {
  const raw = String(value || '').slice(0, 10);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[1]}${match[2]}${match[3]}` : new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

function normalizeParty(party = {}, fallbackName = 'Non renseigne') {
  const siret = digits(party.siret || party.siren);
  return {
    name: party.nom || party.societe || party.name || fallbackName,
    siren: digits(party.siren || siret.slice(0, 9)),
    siret,
    vat: party.tva_num || party.vat || '',
    address: party.adr || party.adresse || party.address || '',
    postcode: party.cp || party.postcode || '',
    city: party.ville || party.city || '',
    country: party.country || 'FR',
    email: party.email || '',
  };
}

function validateInvoice(invoice, seller, buyer) {
  const issues = [];
  const warnings = [];

  if (!invoice.num) issues.push('Numero de facture manquant');
  if (!invoice.date) issues.push('Date d emission manquante');
  if (!invoice.due) warnings.push('Date d echeance manquante');
  if (!seller.name) issues.push('Nom de l emetteur manquant');
  if (!seller.siren && !seller.siret) warnings.push('SIREN/SIRET emetteur manquant');
  if (!seller.address || !seller.postcode || !seller.city) warnings.push('Adresse emetteur incomplete');
  if (!buyer.name) issues.push('Nom du client manquant');
  if (!buyer.address || !buyer.postcode || !buyer.city) warnings.push('Adresse client incomplete');
  if (!Number(invoice.ht)) issues.push('Montant HT manquant');
  if (Number(invoice.tva) > 0 && !seller.vat) warnings.push('TVA collectee mais numero TVA emetteur absent');

  return {
    ok: issues.length === 0,
    issues,
    warnings,
    profile: 'Factur-X BASIC WL / CII XML',
  };
}

function buildFacturXXml(invoice, seller, buyer) {
  const vatRate = Number(invoice.tva || 0);
  const vatAmount = Number(invoice.tvaA || (Number(invoice.ht || 0) * vatRate / 100));
  const total = Number(invoice.ttc || Number(invoice.ht || 0) + vatAmount);
  const lineDesc = invoice.desc || 'Prestation de services';
  const invoiceTypeCode = invoice.typeCode || '380';

  return `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100" xmlns:qdt="urn:un:unece:uncefact:data:standard:QualifiedDataType:100">
  <rsm:ExchangedDocumentContext>
    <ram:GuidelineSpecifiedDocumentContextParameter>
      <ram:ID>urn:factur-x.eu:1p0:basicwl</ram:ID>
    </ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument>
    <ram:ID>${xmlEscape(invoice.num)}</ram:ID>
    <ram:TypeCode>${invoiceTypeCode}</ram:TypeCode>
    <ram:IssueDateTime><udt:DateTimeString format="102">${compactDate(invoice.date)}</udt:DateTimeString></ram:IssueDateTime>
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument><ram:LineID>1</ram:LineID></ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct><ram:Name>${xmlEscape(lineDesc)}</ram:Name></ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement>
        <ram:NetPriceProductTradePrice><ram:ChargeAmount>${amount(invoice.ht)}</ram:ChargeAmount></ram:NetPriceProductTradePrice>
      </ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery>
        <ram:BilledQuantity unitCode="C62">1</ram:BilledQuantity>
      </ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        <ram:ApplicableTradeTax>
          <ram:TypeCode>VAT</ram:TypeCode>
          <ram:CategoryCode>${vatRate > 0 ? 'S' : 'Z'}</ram:CategoryCode>
          <ram:RateApplicablePercent>${amount(vatRate)}</ram:RateApplicablePercent>
        </ram:ApplicableTradeTax>
        <ram:SpecifiedTradeSettlementLineMonetarySummation>
          <ram:LineTotalAmount>${amount(invoice.ht)}</ram:LineTotalAmount>
        </ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>
    <ram:ApplicableHeaderTradeAgreement>
      <ram:SellerTradeParty>
        <ram:Name>${xmlEscape(seller.name)}</ram:Name>
        ${seller.siret ? `<ram:SpecifiedLegalOrganization><ram:ID schemeID="0002">${xmlEscape(seller.siret)}</ram:ID></ram:SpecifiedLegalOrganization>` : ''}
        ${seller.vat ? `<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${xmlEscape(seller.vat)}</ram:ID></ram:SpecifiedTaxRegistration>` : ''}
        <ram:PostalTradeAddress>
          <ram:PostcodeCode>${xmlEscape(seller.postcode)}</ram:PostcodeCode>
          <ram:LineOne>${xmlEscape(seller.address)}</ram:LineOne>
          <ram:CityName>${xmlEscape(seller.city)}</ram:CityName>
          <ram:CountryID>${xmlEscape(seller.country)}</ram:CountryID>
        </ram:PostalTradeAddress>
      </ram:SellerTradeParty>
      <ram:BuyerTradeParty>
        <ram:Name>${xmlEscape(buyer.name)}</ram:Name>
        ${buyer.siret ? `<ram:SpecifiedLegalOrganization><ram:ID schemeID="0002">${xmlEscape(buyer.siret)}</ram:ID></ram:SpecifiedLegalOrganization>` : ''}
        ${buyer.vat ? `<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${xmlEscape(buyer.vat)}</ram:ID></ram:SpecifiedTaxRegistration>` : ''}
        <ram:PostalTradeAddress>
          <ram:PostcodeCode>${xmlEscape(buyer.postcode)}</ram:PostcodeCode>
          <ram:LineOne>${xmlEscape(buyer.address)}</ram:LineOne>
          <ram:CityName>${xmlEscape(buyer.city)}</ram:CityName>
          <ram:CountryID>${xmlEscape(buyer.country)}</ram:CountryID>
        </ram:PostalTradeAddress>
      </ram:BuyerTradeParty>
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeDelivery>
      <ram:ActualDeliverySupplyChainEvent>
        <ram:OccurrenceDateTime><udt:DateTimeString format="102">${compactDate(invoice.date)}</udt:DateTimeString></ram:OccurrenceDateTime>
      </ram:ActualDeliverySupplyChainEvent>
    </ram:ApplicableHeaderTradeDelivery>
    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
      <ram:ApplicableTradeTax>
        <ram:CalculatedAmount>${amount(vatAmount)}</ram:CalculatedAmount>
        <ram:TypeCode>VAT</ram:TypeCode>
        <ram:BasisAmount>${amount(invoice.ht)}</ram:BasisAmount>
        <ram:CategoryCode>${vatRate > 0 ? 'S' : 'Z'}</ram:CategoryCode>
        <ram:RateApplicablePercent>${amount(vatRate)}</ram:RateApplicablePercent>
      </ram:ApplicableTradeTax>
      <ram:SpecifiedTradePaymentTerms>
        <ram:DueDateDateTime><udt:DateTimeString format="102">${compactDate(invoice.due || invoice.date)}</udt:DateTimeString></ram:DueDateDateTime>
      </ram:SpecifiedTradePaymentTerms>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount>${amount(invoice.ht)}</ram:LineTotalAmount>
        <ram:TaxBasisTotalAmount>${amount(invoice.ht)}</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="EUR">${amount(vatAmount)}</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>${amount(total)}</ram:GrandTotalAmount>
        <ram:DuePayableAmount>${amount(total)}</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>
`;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return json(res, 405, { error: 'Methode non autorisee' });

  const body = req.body || {};
  const invoice = body.invoice || body.facture || {};
  const seller = normalizeParty(body.seller || body.company || {}, 'Emetteur');
  const buyer = normalizeParty(body.buyer || body.client || {}, 'Client');
  const compliance = validateInvoice(invoice, seller, buyer);
  const xml = buildFacturXXml(invoice, seller, buyer);

  return json(res, 200, {
    filename: `${String(invoice.num || 'facture').replace(/[^a-z0-9_-]/gi, '_')}_factur-x.xml`,
    mimeType: 'application/xml',
    xml,
    compliance,
  });
}
