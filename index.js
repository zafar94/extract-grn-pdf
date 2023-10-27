const AWS = require('aws-sdk');
const { Pool } = require('pg');
const PDFDocument = require('pdfkit');
require('aws-sdk/lib/maintenance_mode_message').suppress = true;
const fs = require('fs');
const _ = require('lodash');
const moment = require('moment');
const EmailService = require('./email-service');

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
       
        // const grnQuery = 'SELECT * FROM purchase_order_grn LIMIT 2'; // Adjust SQL query
        // const result = await client.query(grnQuery);

        // const grns = result.rows;
        // const calculatedGRNs = grns;

        // for (const grn of calculatedGRNs) {
        //     await generateAndDownloadPDF(grn);
        // }

        client.release();

        return 'Process completed successfully';
    } catch (error) {
        console.error(error);
        return 'Error processing GRNs';
    } finally {
        pool.end();
    }
};

async function generateAndDownloadPDF(grn) {
    const pdfBuffer = await generatePDF(grn);

    const localFilePath = `grn_${grn.id}.pdf`; // Save at the root of the folder

    fs.writeFileSync(localFilePath, pdfBuffer);
    console.log(`Downloaded PDF for GRN ID: ${grn.id} to ${localFilePath}`);
}

// function generatePDF(grn) {
//     return new Promise((resolve) => {
//         const doc = new PDFDocument();
//         // Customize PDF content for the GRN
//         doc.text(`GRN ID: ${grn.id}`);
//         // Add more content as needed
//         const buffers = [];
//         doc.on('data', (buffer) => buffers.push(buffer));
//         doc.on('end', () => {
//             const pdfBuffer = Buffer.concat(buffers);
//             resolve(pdfBuffer);
//         });
//         doc.end();
//     });
// }

handler();


async function getBulkPurchaseOrderGRNPdfs(client) {
    const zip = new jszip();
    const purchaseOrders = await client.query(getPOGRNDetailsWithSupplierProductDetails);
    const groupByPoId = this.groupBy(purchaseOrders, 'id');
    const pdfPromises = [];
    // console.log('groupByPoId-->', groupByPoId.length)
    for (const po of groupByPoId) {
        try {

            // const currency = await this.currencyRepository.findOneOrFail(po[0].currencyid);
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
                    // receipt = receipt.replace(textToRemove, '');
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
                // totalPrice: po[0].totalprice,
                warehouse: po[0].warehousename,
                // poDeliveryPersonName: po[0].deliverypersonname,
                // poDeliveryPersonContact: po[0].deliverypersoncontact,
                checkInUserName: po[0].firstname ? `${po[0].firstname} ${po[0].lastname}` : '-',
                checkInUserContact: po[0].checkinusercontact ? po[0].checkinusercontact : '-',
                checkInTime: moment.tz(po[0].createdat, 'Asia/Karachi').format('YYYY-MM-DD HH:mm'), //done
                grnName: po[0].grnname,
                distributorName: po[0].suppliername,
                // salesTaxStatus: po[0].salestax && pog.salestax > 0 ? 'Exclusive' : 'Inclusive',
                // amount: totalPrice,
                // deliveryCharges: pog.deliverycharges,
                // deliveryChargesComments: pog.deliverychargescomments,
                // total: totalPrice + pog.deliverycharges + pog.salestax,
                // salesTax: pog.salestax,
                // receipts,
                // currencyCode: 'PKR',
                // invoiceAmount: totalPrice,
                // advanceIncomeTax: pog.advanceincometax,
                // discount: pog.discount,
                // promotion: pog.promotion,
                receiptsCombined: receipts,
                totalPOAmount,
                grns: uniqueGrns.map(grn => {
                    // console.log('single GRN --->>', grn)
                    const payload = {
                        // salesTaxStatus: grn.salestax && grn.salestax > 0 ? 'Exclusive' : 'Inclusive',
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

                    // const item = JSON.parse(checkinitem)
                    const payload = {
                        name: checkinitem.productname,
                        totalPrice: checkinitem.producttotalprice,
                        unitPrice: checkinitem.productunitprice,
                        checkedInQuantity: checkinitem.checkedinquantity,
                    };
                    return payload;
                })
            }
            // console.log('templatePayload', templatePayload)
            const html = await EmailService.renderEmailTemplate(
                TemplateNameEnums.purchaseOrderGRN,
                templatePayload,
            );
            // pdfPromises.push(this.pdfService.getPdfBuffer(html, { timeout: 1800000 }).then(pdfBuffer => {
            //     console.log(templatePayload.grnName)
            //     zip.file(`GRN--NEW--${templatePayload.grnName}---${templatePayload.warehouse}---${templatePayload.date}.pdf`, pdfBuffer);
            // }));
        }
        catch (err) {
            // handle error
            console.log('handling error', err)
        }
    }
    await Promise.all(pdfPromises);
    const zipPdf = await zip.generateAsync({ type: "nodebuffer" });
    return zipPdf;
}


async function getPOGRNDetailsWithSupplierProductDetails() {
    const query = `
    select po.id id, po.created_at createdAt, d.name supplierName,
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
        and pog.id in (${grnIds})`;

    return query;
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

function generatePDF(htmlContent) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument();
        const buffers = [];

        doc.on('data', (buffer) => buffers.push(buffer));
        doc.on('end', () => {
            const pdfBuffer = Buffer.concat(buffers);

            pdf.create(htmlContent).toBuffer((err, htmlPdfBuffer) => {
                if (err) {
                    reject(err);
                } else {
                    const mergedBuffer = Buffer.concat([pdfBuffer, htmlPdfBuffer]);
                    resolve(mergedBuffer);
                }
            });
        });


        doc.end();
    });
}
