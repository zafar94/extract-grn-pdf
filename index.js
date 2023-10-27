const AWS = require('aws-sdk');
const { Pool } = require('pg');
const PDFDocument = require('pdfkit');
require('aws-sdk/lib/maintenance_mode_message').suppress = true;
const fs = require('fs');

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
        const grnQuery = 'SELECT * FROM purchase_order_grn LIMIT 2'; // Adjust SQL query
        const result = await client.query(grnQuery);

        const grns = result.rows;
        const calculatedGRNs = grns;

        for (const grn of calculatedGRNs) {
            await generateAndDownloadPDF(grn);
        }

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

function generatePDF(grn) {
    return new Promise((resolve) => {
        const doc = new PDFDocument();
        // Customize PDF content for the GRN
        doc.text(`GRN ID: ${grn.id}`);
        // Add more content as needed
        const buffers = [];
        doc.on('data', (buffer) => buffers.push(buffer));
        doc.on('end', () => {
            const pdfBuffer = Buffer.concat(buffers);
            resolve(pdfBuffer);
        });
        doc.end();
    });
}

handler();
