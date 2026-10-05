import { AwsProtocolAPI, AwsError, awsRecord, awsList, awsRequired, awsPage, awsMd5, awsXml, awsParseXml, type AwsInput, type AwsOperation, type AwsProtocolOptions } from "@crvouga/mockingbird-service"
import { document, operationIds, supportedOperationIds } from "./generated/openapi.js"
export { document, operationIds, supportedOperationIds }
export { createRuntime } from "./runtime.js"
export type { RuntimeOptions, Runtime } from "./runtime.js"
export type APIOptions = AwsProtocolOptions
export class AcmAPI extends AwsProtocolAPI {
  constructor(options: APIOptions = {}) { super("acm", options) }
  dispatch({operation,input}:AwsOperation):unknown {
    const certificates=this.collection("certificates")
    if (operation==="RequestCertificate" || operation==="ImportCertificate") { const domain=operation==="RequestCertificate"?awsRequired(input,"DomainName"):"imported.test", arn=String(input.CertificateArn ?? this.arn("certificate/",this.ids.next("",36),"acm")); certificates.insert(arn,{ CertificateArn:arn,DomainName:domain,SubjectAlternativeNames:input.SubjectAlternativeNames ?? [domain],Status:operation==="ImportCertificate"?"ISSUED":"PENDING_VALIDATION",Type:operation==="ImportCertificate"?"IMPORTED":"AMAZON_ISSUED",CreatedAt:this.now()/1000,KeyAlgorithm:input.KeyAlgorithm ?? "RSA_2048",InUseBy:[],Tags:input.Tags ?? [],Certificate:input.Certificate,CertificateChain:input.CertificateChain,DomainValidationOptions:[{DomainName:domain,ValidationDomain:domain,ValidationStatus:"PENDING_VALIDATION",ValidationMethod:input.ValidationMethod ?? "DNS",ResourceRecord:{Name:`_${awsMd5(domain)}.${domain}.`,Type:"CNAME",Value:`_${awsMd5(arn)}.acm-validations.aws.`}}] }); return {CertificateArn:arn} }
    if (operation==="ListCertificates") return {CertificateSummaryList:certificates.list({order:"oldest",where:item=>!input.CertificateStatuses || awsList(input.CertificateStatuses).includes(item.Status)}).map(({value})=>({CertificateArn:value.CertificateArn,DomainName:value.DomainName,Status:value.Status,Type:value.Type,KeyAlgorithm:value.KeyAlgorithm}))}
    const arn=awsRequired(input,"CertificateArn"), certificate=this.get("certificates",arn)
    if (operation==="DescribeCertificate") {const {Tags:_tags,Certificate:_certificate,CertificateChain:_chain,...rest}=certificate;return {Certificate:rest}}
    if (operation==="DeleteCertificate") {certificates.delete(arn);return {}}
    if (operation==="GetCertificate") {if (certificate.Status!=="ISSUED") throw new AwsError("RequestInProgressException","Certificate is not issued");return {Certificate:certificate.Certificate,CertificateChain:certificate.CertificateChain}}
    if (operation==="ListTagsForCertificate") return {Tags:certificate.Tags ?? []}
    if (operation==="AddTagsToCertificate" || operation==="RemoveTagsFromCertificate") {const incoming=operation==="AddTagsToCertificate"?awsList(input.Tags).map(awsRecord):[],removed=awsList(input.Tags).map(awsRecord).map(tag=>tag.Key);certificates.insert(arn,{...certificate,Tags:[...awsList(certificate.Tags).map(awsRecord).filter(tag=>!removed.includes(tag.Key)),...incoming]});return {}}
    return this.unsupported(operation)
  }

}
