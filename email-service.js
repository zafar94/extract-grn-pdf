const ejs = require('ejs');
const path = require('path');

class EmailService {

    async renderEmailTemplate(templateName, data, options) {
        try {
            const templateCompletePath = path.resolve('./purchaseOrderGRN.ejs');
            return ejs.renderFile(templateCompletePath, data, options);
        } catch (err) {
            console.log('renderEmailTemplate ERRROR', err);
        }
    }
}

module.exports = EmailService;
