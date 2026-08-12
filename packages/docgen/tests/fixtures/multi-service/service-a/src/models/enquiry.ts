import mongoose, { Schema } from 'mongoose';
const EnquirySchema = new Schema({ subject: String });
mongoose.model('Enquiry', EnquirySchema);
