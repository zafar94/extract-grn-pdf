const puppeteer = require("puppeteer-core");
const AWS = require('aws-sdk');
const { Pool } = require('pg');
require('aws-sdk/lib/maintenance_mode_message').suppress = true;
const fs = require('fs');
const _ = require('lodash');
const moment = require('moment');
const ejs = require('ejs');
const chromium = require("@sparticuz/chromium");

AWS.config.update({
    accessKeyId: 'YOUR_ACCESS_KEY',
    secretAccessKey: 'YOUR_SECRET_KEY',
    region: 'YOUR_S3_REGION',
});

const s3 = new AWS.S3();
const pages = [];
exports.handler = async (event, context) => {
    const pool = new Pool(dbConfig);

    try {
        const client = await pool.connect();

        await getBulkPurchaseOrderGRNPdfs(client)

        client.release();

        return {
            status: 200,
            message: 'Process completed successfully'
        };
    } catch (error) {
        console.error(error);
        return 'Error processing GRNs';
    } finally {
        pool.end();
    }
};

async function getBulkPurchaseOrderGRNPdfs(client) {
    const poExtractionData = await getPOIdsToExtract(client);
    const purchaseOrders = await getPOGRNDetailsWithSupplierProductDetails(client, getGRNIds(poExtractionData.rows));
    const groupByPoId = groupBy(purchaseOrders.rows, 'id');
    const browser = await puppeteer.launch({
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
        ignoreHTTPSErrors: true,
        defaultViewport: chromium.defaultViewport,
        args: [...chromium.args, "--hide-scrollbars", "--disable-web-security"],
    });
    for (const po of groupByPoId) {
        try {
            let url = 'https://airlift-grocer-production-uploads-misc.s3.ap-southeast-1.amazonaws.com' + '/';
            url += 'po-invoices' + '/';

            const unsortedUniqueGrns = _.uniqBy(po, 'grnid');
            const uniqueGrns = unsortedUniqueGrns.sort((a, b) => {
                if (a.grnname < b.grnname) return -1;
                if (a.grnname > b.grnname) return 1;
                return 0;
            });
            const uniquePurchaseOrderItems = _.uniqBy(po, 'purchaseorderitemid');
            const receiptsCombined = _.uniq(_.flatten(uniqueGrns.map((grn) => grn.invoicereceipts)));
            const receipts = []
            const textToRemove = 'https://airlift-grocer-production-uploads.s3.ap-southeast-1.amazonaws.com/grocer/'

            for (let receipt of receiptsCombined) {
                if (receipt.includes(textToRemove)) {
                    receipts.push(receipt);
                } else {
                    receipts.push(url + receipt);
                }
            }
            let totalPOAmount = 0;
            for (const item of uniqueGrns) {
                totalPOAmount += item.amount
            }

            const templatePayload = {
                poId: po[0].id,
                date: moment(po[0].createdat).format('YYYY-MM-DD'),
                supplierName: po[0].suppliername,
                warehouse: po[0].warehousename,
                checkInUserName: po[0].firstname ? `${po[0].firstname} ${po[0].lastname}` : '-',
                checkInUserContact: po[0].checkinusercontact ? po[0].checkinusercontact : '-',
                checkInTime: moment(po[0].createdat).format('YYYY-MM-DD HH:mm'),
                grnName: po[0].grnname,
                distributorName: po[0].suppliername,
                receiptsCombined: receipts,
                totalPOAmount,
                grns: uniqueGrns.map(grn => {
                    const payload = {
                        amount: grn.amount,
                        deliveryCharges: grn.deliverycharges,
                        deliveryChargesComments: grn.deliverychargescomments,
                        total: grn.amount + grn.deliverycharges + grn.salestax,
                        salesTax: grn.salestax,
                        receipts,
                        currencyCode: 'PKR',
                        invoiceAmount: grn.invoice_amount,
                        advanceIncomeTax: grn.advanceincometax,
                        discount: grn.discount,
                        promotion: grn.promotion,
                        name: grn.grnname
                    };
                    return payload;
                }),
                items: uniquePurchaseOrderItems.map(checkinitem => {
                    const payload = {
                        name: checkinitem.productname,
                        totalPrice: checkinitem.producttotalprice,
                        unitPrice: checkinitem.productunitprice,
                        checkedInQuantity: checkinitem.checkedinquantity,
                    };
                    return payload;
                })
            }
            const fileName = `PO-${templatePayload.poId}---${templatePayload.warehouse}---${templatePayload.date}.pdf`

            await generatePDF(templatePayload, fileName, browser)

        } catch (err) {
            console.log('handling error', err)
        }
    }
    try {
        for (const page of pages) {
            page.close;
        }
    } catch (e) {
        console.log('ERROR IN  BROWSER CLOSED', e)
    }

    await markExtractedData(client, getGRNIds(poExtractionData.rows))
}

async function getPOGRNDetailsWithSupplierProductDetails(client, poIdsToExtract) {
    const result = await client.query(`select po.id id, po.created_at createdAt, d.name supplierName,
        po.total_price totalPrice, w.name warehouseName, p.name productName,
        poi.id purchaseOrderItemId,
        poi.check_in_total_price productTotalPrice, poi.check_in_unit_price productUnitPrice, poi.units productUnits, poi.checked_in_quantity checkedInQuantity,
        pog.invoice_amount, pog.advance_income_tax advanceIncomeTax, po.delivery_person_name deliveryPersonName,
        pog.discount, pog.promotion,
        po.delivery_person_contact deliveryPersonContact, u.first_name firstName, u.last_name lastName, u.contact_number checkinUserContact,
        pog.name grnName, po.created_at poCreatedAt,
        pog.sales_tax salesTax, pog.amount amount, pog.delivery_charges deliveryCharges, pog.delivery_charges_comments deliveryChargesComments,
        pogi.receipts invoiceReceipts, pog.id grnid
        from purchase_order po
        left join purchase_order_item poi on po.id = poi.purchase_order_id
        left join "user" u on u.id = po.check_in_user_id
        left join product p on p.id = poi.product_id
        left join distributor d on d.id = po.distributor_id
        left join warehouse w on w.id = po.warehouse_id
        left join purchase_order_grn pog on po.id = pog.purchase_order_id
        left join purchase_order_grn_invoices pogi on pog.id = pogi.purchase_order_grn_id
        where po.deleted_at is null and poi.deleted_at is null
        and p.deleted_at is null
        and d.deleted_at is null and w.deleted_at is null
        and pog.deleted_at is null
        and pogi.deleted_at is null
        and pogi."type" = 'FINAL'
        and pog.purchase_order_id in (${poIdsToExtract})`);

    return result;
}

async function getPOIdsToExtract(client) {
    const result = await client.query(`SELECT po_id, extracted, extracted_time FROM po_extraction_track
        where extracted = false and extracted_time is null 
        order by po_id desc
        limit 10;`)

    return result;
}


async function markExtractedData(client, grnIds) {
    await client.query(`update po_extraction_track 
            set extracted = true, extracted_time = now() where po_id in (${grnIds})`)
}

function getGRNIds(poExtractionData) {
    return poExtractionData.map(ped => ped.po_id)
}

function groupBy(collection, property) {
    var i = 0, val, index,
        values = [], result = [];
    for (; i < collection.length; i++) {
        val = collection[i][property];
        index = values.indexOf(val);
        if (index > -1)
            result[index].push(collection[i]);
        else {
            values.push(val);
            result.push([collection[i]]);
        }
    }
    return result;
}

async function generatePDF(templatePayload, fileName, browser) {

    const page = await browser.newPage()
    const templateCompletePath = fs.readFileSync('./purchaseOrderGRN.ejs', 'utf8')
    const htmlContent = ejs.render(templateCompletePath, templatePayload);
    await page.setContent(htmlContent)

    const pdfBuffer = await page.pdf({
        format: 'A4'
    })

    const s3Params = {
        Bucket: 'airlift-26-10-2023-zafar',
        Key: fileName,
        Body: pdfBuffer,
        ContentType: 'application/pdf',
    };

    await s3.putObject(s3Params).promise();
    pages.push(page)
    await browser.close()
}
