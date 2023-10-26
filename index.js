const AWS = require('aws-sdk');
const { Pool } = require('pg');
const PDFDocument = require('pdfkit');

const s3 = new AWS.S3();
const dbConfig = {
    user: 'your_db_user',
    host: 'your_db_host',
    database: 'your_db_name',
    password: 'your_db_password',
    port: 5432, // Change to your database port
};

exports.handler = async (event, context) => {
    // Create a PostgreSQL connection pool
    const pool = new Pool(dbConfig);

    try {
        // Fetch 10 GRNs from the PostgreSQL database
        const client = await pool.connect();
        const grnQuery = 'SELECT * FROM your_grn_table LIMIT 10'; // Adjust SQL query
        const result = await client.query(grnQuery);

        // Perform calculations with the GRNs
        const grns = result.rows;
        const calculatedGRNs = grns.map(calculateGRN); // Implement your calculations

        // Generate PDFs for each GRN
        const pdfPromises = calculatedGRNs.map(generatePDF);

        // Wait for all PDFs to be generated
        const pdfBuffers = await Promise.all(pdfPromises);

        // Upload PDFs to S3
        const s3UploadPromises = pdfBuffers.map((pdfBuffer, index) => {
            const s3Params = {
                Bucket: 'your-s3-bucket-name',
                Key: `grn_${grns[index].id}.pdf`,
                Body: pdfBuffer,
            };
            return s3.upload(s3Params).promise();
        });

        // Wait for all uploads to complete
        await Promise.all(s3UploadPromises);

        // Release the database connection
        client.release();

        return 'Process completed successfully';
    } catch (error) {
        console.error(error);
        return 'Error processing GRNs';
    } finally {
        // Release the database connection from the pool
        pool.end();
    }
};

function calculateGRN(grn) {
    // Implement your calculations here
    return grn;
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
