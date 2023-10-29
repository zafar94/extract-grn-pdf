const AWS = require('aws-sdk');
const { Pool } = require('pg');
require('aws-sdk/lib/maintenance_mode_message').suppress = true;
const fs = require('fs');
const _ = require('lodash');
const moment = require('moment');
const ejs = require('ejs');
const path = require('path');
const puppeteer = require('puppeteer')

const dbConfig = {
    user: 'postgres',
    host: 'grocerapi-snapshot-13-07-2022-zafar-cluster.cluster-ci41v1phpkmy.ap-southeast-1.rds.amazonaws.com',
    database: 'airlift_grocer',
    password: 'grocerapi-snapshot-13-07-2022',
    port: 5432,
};

handler = async (event, context) => {
    const pool = new Pool(dbConfig);

    try {
        const client = await pool.connect();

        await getBulkPurchaseOrderGRNPdfs(client)

        client.release();

        return 'Process completed successfully';
    } catch (error) {
        console.error(error);
        return 'Error processing GRNs';
    } finally {
        pool.end();
    }
};

handler();

async function getBulkPurchaseOrderGRNPdfs(client) {
    // const zip = new jszip();
    const grnExtractionData = await getGRNIdsToExtract(client);
    const purchaseOrders = await getPOGRNDetailsWithSupplierProductDetails(client, getGRNIds(grnExtractionData.rows));
    const groupByPoId = groupBy(purchaseOrders.rows, 'id');
    const pdfPromises = [];
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
            console.log('FINAL receipts-->>', receipts)
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
                checkInTime: moment(po[0].createdat).format('YYYY-MM-DD HH:mm'), //done
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
            console.log('------HTNLLNLNLNLNN START---->>>')

            console.log('------HTNLLNLNLNLNN---->>>')
            const fileName = `GRN--NEW--${templatePayload.grnName}---${templatePayload.warehouse}---${templatePayload.date}.pdf`

            await generatePDF(templatePayload, fileName)

            // pdfPromises.push(this.pdfService.getPdfBuffer(html, { timeout: 1800000 }).then(pdfBuffer => {
            //     console.log(templatePayload.grnName)
            //     zip.file(`GRN--NEW--${templatePayload.grnName}---${templatePayload.warehouse}---${templatePayload.date}.pdf`, pdfBuffer);
            // }));
        } catch (err) {
            // handle error
            console.log('handling error', err)
        }
    }
    // await Promise.all(pdfPromises);
    // const zipPdf = await zip.generateAsync({ type: "nodebuffer" });
    // return zipPdf;
}

async function getPOGRNDetailsWithSupplierProductDetails(client, grnIdsToExtract) {
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
        and pog.id in (${grnIdsToExtract})`);

    return result;
}

async function getGRNIdsToExtract(client) {
    const result = await client.query(`SELECT grn_id, extracted, extracted_time FROM grn_extraction_track
        where extracted = false and extracted_time is null 
        limit 10;`)

    return result;
}


async function markExtractedData(client, grnIds) {
    await client.query(`update grn_extraction_track 
            set extracted = true, extracted_time = now() where id in (${grnIds})`)
}

function getGRNIds(grnExtractionData) {
    return grnExtractionData.map(ged => ged.grn_id)
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

async function generatePDF(templatePayload, fileName) {
    const browser = await puppeteer.launch()

    const page = await browser.newPage()

    const templateCompletePath = fs.readFileSync('./purchaseOrderGRN.ejs', 'utf8')
    const htmlContent = ejs.render(templateCompletePath, templatePayload);
    await page.setContent(htmlContent)

    const pdfBuffer = await page.pdf({
        format: 'A4'
    })

    await page.pdf({
        format: 'A4',
        path: fileName
    })

    await browser.close()
}
