import {type FormEvent, useState} from 'react'
import Navbar from "~/components/Navbar";
import FileUploader from "~/components/FileUploader";
import {usePuterStore} from "~/lib/puter";
import {useNavigate} from "react-router";
import {convertPdfToImage} from "~/lib/pdf2img";
import {generateUUID} from "~/lib/utils";
import {prepareInstructions} from "../../constants";

const Upload = () => {
    const { auth, isLoading, fs, ai, kv } = usePuterStore();
    const navigate = useNavigate();
    const [isProcessing, setIsProcessing] = useState(false);
    const [statusText, setStatusText] = useState('');
    const [file, setFile] = useState<File | null>(null);

    const handleFileSelect = (file: File | null) => {
        setFile(file)
    }

    const handleAnalyze = async ({ companyName, jobTitle, jobDescription, file }: { companyName: string, jobTitle: string, jobDescription: string, file: File  }) => {
        setIsProcessing(true);

        // #region agent log
        fetch('http://127.0.0.1:7295/ingest/52efaa85-769f-4f50-85ce-2752439ee9f4', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Debug-Session-Id': '66b324',
            },
            body: JSON.stringify({
                sessionId: '66b324',
                runId: 'initial',
                hypothesisId: 'H1',
                location: 'upload.tsx:handleAnalyze',
                message: 'handleAnalyze start',
                data: {
                    isAuthenticated: auth.isAuthenticated,
                    hasCompanyName: !!companyName,
                    hasJobTitle: !!jobTitle,
                    hasJobDescription: !!jobDescription,
                    hasFile: !!file,
                },
                timestamp: Date.now(),
            }),
        }).catch(() => {});
        // #endregion

        if (!auth.isAuthenticated) {
            setStatusText('Error: Please sign in first');
            setIsProcessing(false);
            return;
        }

        setStatusText('Uploading the file...');
        const uploadResult = await fs.upload([file]);
        const uploadedFile = Array.isArray(uploadResult) ? uploadResult[0] : uploadResult;
        if(!uploadedFile) {
            setStatusText('Error: Failed to upload file');
            setIsProcessing(false);
            return;
        }

        setStatusText('Converting to image...');
        const imageFile = await convertPdfToImage(file);
        if(!imageFile.file) {
            setStatusText('Error: Failed to convert PDF to image');
            setIsProcessing(false);
            return;
        }

        setStatusText('Uploading the image...');
        const imageUploadResult = await fs.upload([imageFile.file]);
        const uploadedImage = Array.isArray(imageUploadResult) ? imageUploadResult[0] : imageUploadResult;
        if(!uploadedImage) {
            setStatusText('Error: Failed to upload image');
            setIsProcessing(false);
            return;
        }

        setStatusText('Preparing data...');
        const uuid = generateUUID();
        const data = {
            id: uuid,
            resumePath: uploadedFile.path,
            imagePath: uploadedImage.path,
            companyName, jobTitle, jobDescription,
            feedback: '',
        }
        await kv.set(`resume:${uuid}`, JSON.stringify(data));

        setStatusText('Analyzing...');

        let feedback;
        try {
            // #region agent log
            fetch('http://127.0.0.1:7295/ingest/52efaa85-769f-4f50-85ce-2752439ee9f4', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Debug-Session-Id': '66b324',
                },
                body: JSON.stringify({
                    sessionId: '66b324',
                    runId: 'initial',
                    hypothesisId: 'H2',
                    location: 'upload.tsx:handleAnalyze',
                    message: 'before ai.feedback',
                    data: {
                        imagePath: uploadedImage.path,
                    },
                    timestamp: Date.now(),
                }),
            }).catch(() => {});
            // #endregion

            console.log('--- Calling ai.feedback ---');
            console.log('Image File Name:', imageFile.file?.name);
            const instructions = prepareInstructions({ jobTitle, jobDescription });
            console.log('Instructions:', instructions);

            feedback = await ai.feedback(
                imageFile.file as File,
                instructions
            );
            
            console.log('--- Raw AI Feedback Response ---');
            console.log(feedback);
        } catch (error: any) {
            console.error('AI feedback error:', error);
            console.log('Detailed error stringified:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
            
            let errMsg = 'Unknown error';
            if (error instanceof Error) {
                errMsg = error.message;
            } else if (typeof error === 'string') {
                errMsg = error;
            } else if (error && typeof error === 'object') {
                errMsg = JSON.stringify(error, null, 2);
            }

            setStatusText(`Error: Failed to analyze resume - ${errMsg}`);
            setIsProcessing(false);
            return;
        }
        
        if (!feedback) {
            setStatusText('Error: Failed to analyze resume');
            setIsProcessing(false);
            return;
        }

        const feedbackText = typeof feedback === 'string'
            ? feedback
            : (typeof feedback.message?.content === 'string'
                ? feedback.message.content
                : feedback.message?.content?.[0]?.text || '');

        let cleanText = feedbackText.trim();
        if (cleanText.startsWith('```json')) {
            cleanText = cleanText.replace(/^```json\s*/, '').replace(/\s*```$/, '');
        }

        let parsedFeedback;
        try {
            parsedFeedback = JSON.parse(cleanText);
            console.log('Parsed feedback:', parsedFeedback);

            // #region agent log
            fetch('http://127.0.0.1:7295/ingest/52efaa85-769f-4f50-85ce-2752439ee9f4', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Debug-Session-Id': '66b324',
                },
                body: JSON.stringify({
                    sessionId: '66b324',
                    runId: 'initial',
                    hypothesisId: 'H3',
                    location: 'upload.tsx:handleAnalyze',
                    message: 'parsed feedback JSON',
                    data: {
                        overallScore: parsedFeedback.overallScore,
                        atsScore: parsedFeedback.ATS?.score,
                    },
                    timestamp: Date.now(),
                }),
            }).catch(() => {});
            // #endregion
        } catch (error) {
            console.error('JSON parse error:', error, 'Text:', cleanText);
            setStatusText('Error: Invalid response from AI');
            setIsProcessing(false);
            return;
        }

        data.feedback = parsedFeedback;
        await kv.set(`resume:${uuid}`, JSON.stringify(data));
        setStatusText('Analysis complete, redirecting...');
        console.log(data);
        navigate(`/resume/${uuid}`);
    }

    const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const form = e.currentTarget.closest('form');
        if(!form) return;
        const formData = new FormData(form);

        const companyName = formData.get('company-name') as string;
        const jobTitle = formData.get('job-title') as string;
        const jobDescription = formData.get('job-description') as string;

        if(!file) return;

        handleAnalyze({ companyName, jobTitle, jobDescription, file });
    }

    return (
        <main className="bg-[url('/images/bg-main.svg')] bg-cover">
            <Navbar />

            <section className="main-section">
                <div className="page-heading py-16">
                    <h1>Smart feedback for your dream job</h1>
                    {isProcessing ? (
                        <>
                            <h2 className="whitespace-pre-wrap">{statusText}</h2>
                            <img src="/images/resume-scan.gif" className="w-full" />
                        </>
                    ) : (
                        <>
                            {statusText && <div className="p-4 bg-red-100 text-red-800 rounded-md w-full whitespace-pre-wrap font-mono text-sm max-h-64 overflow-auto border border-red-300">{statusText}</div>}
                            <h2>Drop your resume for an ATS score and improvement tips</h2>
                        </>
                    )}
                    {!isProcessing && (
                        <form id="upload-form" onSubmit={handleSubmit} className="flex flex-col gap-4 mt-8">
                            <div className="form-div">
                                <label htmlFor="company-name">Company Name</label>
                                <input type="text" name="company-name" placeholder="Company Name" id="company-name" />
                            </div>
                            <div className="form-div">
                                <label htmlFor="job-title">Job Title</label>
                                <input type="text" name="job-title" placeholder="Job Title" id="job-title" />
                            </div>
                            <div className="form-div">
                                <label htmlFor="job-description">Job Description</label>
                                <textarea rows={5} name="job-description" placeholder="Job Description" id="job-description" />
                            </div>

                            <div className="form-div">
                                <label htmlFor="uploader">Upload Resume</label>
                                <FileUploader onFileSelect={handleFileSelect} />
                            </div>

                            <button className="primary-button" type="submit">
                                Analyze Resume
                            </button>
                        </form>
                    )}
                </div>
            </section>
        </main>
    )
}
export default Upload
